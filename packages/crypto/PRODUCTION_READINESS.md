# Crypto satellite: production readiness

> Status: the encryption engine is well built and about 85% ready. Storing a passport is
> safe once it is encrypted, but before you can honestly honor a customer's "delete my
> data" request, three things must be closed (sections 5.1 to 5.3). Everything else on
> this page is hardening you do before going live, not before testing.

## Who this is for and how to read it

This document is written for three people, and it assumes **none of them is a lawyer**:

- **The owner / product lead** — you decide what the business does, you talk to legal.
- **The senior developer (Ismael's sister)** — she wires the missing pieces into the rental.
- **The security specialist** — he attacks the design and owns the "does erasure really
  erase" work.

Read sections 1 to 4 to understand what the engine promises. Read section 5 if you are
about to store or promise to erase real personal data (it lists the three blockers). Read
sections 6 to 10 to plan for production. If you only remember one sentence, remember this:

> **Crypto executes the bytes. The company decides what is legal to delete.** The library
> can destroy a key on command, but it never decides whether destroying that key is lawful.

### TL;DR

1. The encryption engine (keys, shredding, rotation, search index) is solid. Do not
   rewrite it.
2. **Blocker #1:** today, a "delete this customer" request is *refused*, not executed,
   because the legal-decision hook is not wired. Fixable in about 40 lines (section 5.1).
3. **Blocker #2:** encryption only protects the data inside the "safe". If a passport
   number also lives in AI embeddings, logs, a URL, or an email your app sent, destroying
   the key does not erase those plaintext copies (section 5.2).
4. **Blocker #3 (verified against the code):** the shred is *reversible from a backup*.
   The wrapped key lives in the same database that gets backed up, and the shred never
   destroys the master key, so restoring a backup taken before the shred brings the
   "erased" passport back to life. `ARCHITECTURE.md` claimed the opposite; that claim has
   now been corrected to match the engine's real behavior (section 5.3).
5. Hardening (production key backend, disaster recovery, key rotation runbook,
   cancellable-shred grace window) is real but does not block staging.

---

## 1. Without jargon: what encryption promises, and what it does NOT

Think of each customer's sensitive data as being locked inside a **safe**, and every safe
has its own unique **key**.

- **Encryption at rest** means: if a thief steals the whole database, they get a pile of
  locked safes, not the passports inside them.
- **Crypto-shredding** (how we honor "delete my data") means: instead of emptying the
  safe, we **destroy the only live key**. The safe is now sealed, and nobody can open it
  again with the live key material.

Here is the honest limit, and it is the most important idea on this page. There are
exactly **two ways** a shred can fail to erase, and the rental has to close both:

1. **A plaintext copy escaped the safe.** The passport was written in the clear somewhere
   else: an application log, an AI index, a URL, an email. Throwing the key away does not
   touch that copy. (Section 5.2.)
2. **A recoverable copy of the *key* survived.** This is the subtle one. The key that
   opens the safe is itself stored, wrapped, inside the database. If a database backup, a
   replica snapshot, or a query log captured that wrapped key *before* the shred, and the
   master key is still alive, someone can rebuild the safe key and re-open the safe. The
   ciphertext never left, but the lock can be picked again. (Section 5.3.)

The engine handles the safe and the live key correctly. Closing these two escape routes is
an integration and operations job for the rental.

---

## 2. A plain-language legal glossary

You do not need to be a lawyer, but you need to understand these seven terms, because the
engine asks you to make decisions that depend on them.

| Term | In plain words | Example in the rental |
|---|---|---|
| **Right to be forgotten (RTBF)** | A customer can ask you to delete their personal data. | A former renter emails: "delete everything you have on me." |
| **Legal basis** | The *reason* you are allowed to hold a piece of data. Two common ones: **consent** (they agreed, and can withdraw it) and **legal obligation** (a law forces you to keep it). | Marketing preferences = consent. A signed rental contract = legal obligation. |
| **Retention window** | How long a law requires you to keep something, even against the customer's wishes. | Tax/commercial law may require keeping a signed contract for X years. |
| **Erasure SLA / deadline** | How long you are allowed to take to actually complete a deletion request. This sets how long a pre-shred backup may keep living (section 5.3). | GDPR expects erasure "without undue delay". |
| **Sensitive personal data** | Data that identifies a person and can cause real harm if leaked. Passport and national-ID numbers qualify. | The passport number you copy at pickup. |
| **CNDP / Ley 09-08** | Morocco's data-protection law and its regulator (the CNDP). It governs how you handle Moroccan customers' data. | Your rental operates in Morocco, so this applies. |
| **GDPR** | The EU's data-protection law. It applies if you serve EU residents. | A tourist from France renting a car. |
| **Data controller** | The party legally responsible for the data. **That is your company, never the software library.** | Lasagna gives you tools; you are accountable for using them lawfully. |

The one rule that ties this all together and is baked into the engine:

> When a customer asks to be forgotten, you may **not** blindly delete everything. Data
> held under a **legal obligation** inside its **retention window** must be kept, even
> then. Deleting a signed contract too early is itself a violation, in the other
> direction. The engine refuses to over-delete on purpose.

---

## 3. What is already built and reliable

This is high-quality work. Do not rewrite it.

- **Correct key hierarchy.** A master key (KEK) wraps a data key (DEK), and there is one
  DEK per `(customer × category)`. This granularity is the whole point: you can shred one
  customer's marketing data without touching their contract, and shred customer A without
  touching customer B. See [`src/services/crypto_service.ts`](src/services/crypto_service.ts).
- **Two-phase crypto-shred.** The erasure writes an audit record *before* it destroys the
  key and confirms it *after*, so an erasure is never left silently unaudited. Mechanically
  the shred does not delete the row; it nulls the wrapped key in one atomic statement
  (`UPDATE ... SET shredded_at = now(), wrapped_dek = NULL`), keeping the row as a tombstone.
  Irreversibility comes from nulling the key, not from removing the row. It runs under a
  per-tenant lock and is idempotent. See
  [`src/services/crypto_service.ts:239`](src/services/crypto_service.ts#L239),
  [`src/services/pg_wrapped_dek_store.ts:225`](src/services/pg_wrapped_dek_store.ts#L225),
  and the command [`src/commands/tenant_crypto_shred.ts`](src/commands/tenant_crypto_shred.ts).
- **Key rotation without re-encrypting data** (`tenant:crypto:rekek`). Rotating the master
  key re-wraps the data keys, an O(number of keys) operation, never a rewrite of every
  field. Resumable, and it reports any key it cannot recover.
  See [`src/services/rekek_service.ts`](src/services/rekek_service.ts).
- **Keyed search index (blind index).** Lets you search encrypted fields for equality
  (find a renter by passport number) using a keyed HMAC, not a guessable hash.
- **Fail-closed everywhere.** Missing key backend, missing data key, or a plaintext write
  to an encrypted field all *throw loudly* rather than silently leaking cleartext.
- **Reference production key backend for HashiCorp Vault**, with SSRF protection and a
  real-Vault smoke test. See [`src/services/vault_key_provider.ts`](src/services/vault_key_provider.ts).

---

## 4. The mental model of the three keys

```
KeyProvider (the Vault/KMS that holds the master key)
   |
   |  wraps
   v
KEK  (master key, Key-Encryption-Key, one per tenant)
   |
   |  wraps
   v
DEK  (Data-Encryption-Key, ONE per (customer × category); the only LIVE copy)
   |
   |  seals
   v
the encrypted passport number in the database
```

- The **KeyProvider** is the source of trust. In development it is `env` (the master key
  is derived from `APP_KEY`, dev-grade). In production it should be Vault or AWS KMS, so
  the raw master key never enters the app process.
- The **DEK** is the safe key from section 1. A shred nulls its one wrapped copy in the
  live database. Crucially, the **master key (KEK) is not destroyed by a shred** (it is
  shared across all of the tenant's customers), and the wrapped DEK also lives in backups.
  That combination is exactly why section 5.3 exists.

---

## 5. The blockers before you can honestly erase a customer's data

These are not "nice to have". Storing a passport is safe once it is encrypted, but you may
not *promise a customer their data can be erased* until all three are closed. Blocker #1
means the deletion cannot run at all; blockers #2 and #3 mean the deletion runs but leaves
recoverable copies behind.

### 5.1 Blocker #1: a "delete this customer" request is refused today

**What happens right now.** If you run the shred command for a real customer, it fails
with `REFUSED` and deletes nothing. That is not a bug, it is a deliberate safety default,
but it means the right to be forgotten does not function yet.

**Why.** The engine never decides on its own whether deletion is legal. It asks a hook
called the *erasability resolver*, which is normally provided by a `governance` satellite
that has **not been built yet**. With no resolver wired, every shred is refused:

```ts
// src/services/crypto_service.ts:246
if (!this.#erasabilityResolver) {
  emitCryptoGuardEvent('guard.crypto_shred_legal_hold', { tenantId: tenant.id })
  throw new CryptoException(
    'shred_refused',
    `... no erasability resolver is wired (governance absent). crypto never erases on its own initiative.`
  )
}
```

This is correct: crypto refusing to guess is exactly what you want. But you have to give
it the answer.

**The two ways out.**

- **(a) Build the full `governance` satellite.** Large, and blocked on legal advice. Do
  not wait for this to ship the rental.
- **(b) Wire a minimal erasability resolver inside the rental.** Recommended. It is a
  small function that encodes the decisions your lawyer gives you: which categories are
  erasable on request, and which are held under a retention window. This is a decision you
  must make anyway to be compliant; you are just writing it down in code.

**Sketch of the minimal resolver (goes in the rental, not in this package).** The exact
type is [`ErasabilityResolver`](src/types/erasability.ts):

```ts
// config/multitenancy.ts (or a small service in the rental)
import { defineCryptoConfig, type ErasabilityResolver } from '@adonisjs-lasagna/crypto'

// The single source of truth for "what may we delete, and when".
// FILL THIS IN WITH YOUR LAWYER. The values below are a plausible EXAMPLE, not advice.
const CATEGORY_RULES: Record<
  string,
  { erasable: boolean; reason: string; retentionYears?: number }
> = {
  // Consent-based: the customer can withdraw it, so it is erasable on request.
  marketing: { erasable: true, reason: 'consent' },

  // Legal obligation: identity documents must be kept while the law requires it.
  'identity-docs': { erasable: false, reason: 'legal-obligation', retentionYears: 5 },

  // Legal obligation: a signed contract is evidence and must survive RTBF.
  'rental-contract': { erasable: false, reason: 'legal-obligation', retentionYears: 10 },
}

const erasabilityResolver: ErasabilityResolver = (_tenant, _subjectId, category) => {
  const rule = CATEGORY_RULES[category]
  // Unknown category => refuse (fail-closed). Never default to "yes, delete".
  if (!rule) return { erasable: false, reason: `unknown category '${category}'` }

  // A real implementation would compare retentionYears against the record's creation
  // date to decide whether the retention window has expired. Kept simple here.
  return {
    erasable: rule.erasable,
    reason: rule.reason,
    retentionUntil: rule.retentionYears ? null : undefined,
  }
}

export default defineMultitenancyConfig({
  // ...
  crypto: defineCryptoConfig({
    keyProvider: 'hashicorp-vault',
    erasabilityResolver,
    fields: {
      'renter.passportNumber': { category: 'identity-docs', searchable: true },
    },
  }),
})
```

**The category rules table your lawyer fills in.** This is the heart of your compliance,
expressed in one table:

| Category | Legal basis | Erasable on RTBF? | Retention window |
|---|---|---|---|
| `marketing` | consent | Yes | none |
| `identity-docs` (passport, DNI) | legal-obligation | Not until window expires | ask legal (example: 5 years) |
| `rental-contract` | legal-obligation | Not until window expires | ask legal (example: 10 years) |

Note the consequence: a passport is most likely **legal-obligation**, which means under a
"forget me" request you **keep** it until the retention window ends, then shred it. That
is the lawful answer, and the engine is designed to give it honestly.

### 5.2 Blocker #2: the passport plaintext may sit somewhere else

Destroying the key only erases what was sealed under that key. Before you trust the shred,
someone (the security specialist) must audit every place a passport number could exist in
**plaintext** in the rental:

| Where to check | Risk | How to close it |
|---|---|---|
| **AI satellite** (pgvector embeddings, chat memory) | If a passport was put into an AI query and indexed, shredding the crypto key leaves it alive in pgvector. | Never feed raw sensitive data to the AI, or encrypt/scope it before indexing, and purge on shred. |
| **Application logs** | A log line printing a renter object leaks the passport in cleartext. | Redact sensitive fields in the logger; never log full model instances. |
| **Error bodies / stack traces** | An exception carrying the value leaks it to logs or an error tracker. | Scrub sensitive fields from error reporting. |
| **HTTP access logs / reverse proxy / APM** | If any route puts the passport in a URL or query string, the reverse proxy (nginx) and APM record the full URL before the app logger runs, so logger redaction does not help. | Never place a passport in a query string (POST body only); strip query strings from access logs. |
| **External processors** (email confirmations, contract PDFs, support tickets, payment-provider metadata) | A confirmation email, a generated contract PDF, or a support ticket that includes the passport keeps it in a system Lasagna does not control; a shred never reaches it. | Suppress the field from those payloads; add each processor to the erasure runbook and issue a downstream deletion request. |
| **The blind (search) index** | Documented limit (I5/T14): a shred kills the encrypted value but does NOT null the search-index column. | The rental must null the index column for the shredded `(customer × category)`, or delete the owning row. |
| **Job queues / caches** | A queued job or a cached API response holding the plaintext outlives the shred. | Avoid putting raw sensitive data in payloads/caches; set short TTLs. |

Output of this audit: for each row above, either "closed" with how, or "documented as a
known limit" so nobody oversells the guarantee.

### 5.3 Blocker #3: the shred can be reversed from a backup (verified)

**This is the most surprising finding, and it was verified against the actual code twice,
including an adversarial pass that tried four different ways to disprove it and failed.**

**Plain version.** You encrypt a passport today. A customer asks to be forgotten next
month. You run the shred. Everything looks erased. But last week's database backup still
contains the *wrapped key*, and your master key never changed. Restore that backup and the
passport decrypts again. The right to be forgotten is not satisfied while that backup
exists.

**Why it happens (each link verified in the code):**

- The shred does not delete data bytes. It nulls the *wrapped key* for that
  `(customer × category)`: `UPDATE ... SET shredded_at = now(), wrapped_dek = NULL`
  ([`pg_wrapped_dek_store.ts:225`](src/services/pg_wrapped_dek_store.ts#L225)). It never
  touches the master key.
- The wrapped-key table lives **inside the tenant's own schema** (`tenant_<uuid>`), the
  same schema the backup dumps ([`tenant_migrations/...create_crypto_wrapped_deks_table.ts`](tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts)).
- The backup runs `pg_dump --schema=tenant_<uuid>` with **no table exclusion**
  ([`packages/backup/src/services/backup_service.ts`](../backup/src/services/backup_service.ts)),
  so a backup taken before the shred contains a live wrapped key, which is a second copy
  of the key.
- The master key (KEK) is per-tenant and **survives a per-customer shred** (env: derived
  from `APP_KEY`; Vault: the tenant's transit key). Destroying it is not an option for a
  single-customer erasure, because it would brick every other customer of that tenant.
- Restore brings the wrapped key back; the surviving master key unwraps it; the passport
  decrypts.

So crypto-shred is O(1)-final on the *live* database and on backups taken *after* the
shred. It does **not** reach backups, WAL archives, replica snapshots, or clones taken
*before* the shred.

> **This contradicted the code's own design doc, now fixed.** `ARCHITECTURE.md` (I6, §6.6,
> §10) used to state that a shred "kills every backup under that DEK simultaneously" and "a
> restored dump still cannot be decrypted". That is false for any backup predating the
> shred. **Those sentences in `ARCHITECTURE.md` (I6, T8, §6.6, §10, and the §1
> honest-limits list) plus the matching docstring in `crypto_service.ts` were corrected in
> this pass** so nobody relies on a guarantee the engine does not provide. The *code* was
> always honest; the prose now matches it.

The full list of places a recoverable copy of the *key* survives a shred:

| Where a recoverable KEY copy survives | Why it defeats the shred | How to close it |
|---|---|---|
| **Pre-shred database backups** (`pg_dump --schema=tenant_<id>`) | The dump captures the live wrapped key next to the ciphertext; restore + surviving master key = decryptable. | Keep backup retention shorter than your erasure deadline, and treat a shred as final only once every pre-shred backup has expired or been re-dumped; OR rotate and *destroy the old master-key generation* after the window; OR move the wrapped-key store outside the per-tenant dump scope. |
| **WAL / PITR archive, base backups, volume snapshots** | If point-in-time recovery is enabled, the WAL segments contain the wrapped-key writes; a PITR restore to before the shred resurrects it. | Bound WAL/PITR retention below the erasure deadline; exclude it from the erasure promise in writing; or age out WAL older than the shred. |
| **DB / ORM / pooler query logs** (`log_statement=all`, pgAudit, Lucid debug, pgbouncer verbose) | The `INSERT ... wrapped_dek = 'enc_v2:...'` binding is written verbatim to a log file. That line is a copy of the key. (Different from the "application logs" row above, which is about the passport *plaintext*.) | Do not log statements on the crypto table in prod; disable ORM connection debug logging; keep the pooler at connection-level logging; treat any store that captured the binding as tainted after a shred. |
| **Tenant clones / SQL imports into staging/QA** | `packages/backup` clone/import copies `crypto_wrapped_deks` (live keys) to another environment; a prod shred never reaches the clone (same `APP_KEY` = same master key). | Track every clone/import target, propagate shreds, or scrub and re-provision the wrapped-key table when cloning into lower environments. |
| **Replica snapshots / delayed replicas** | A live standby converges on the shred, but a replica *snapshot* or a delayed replica taken before it holds the live wrapped key (a backup-class copy). | Run no apply-delay on tenant data; put replica snapshots under the same post-shred purge policy as primary backups. |

Two things that do **not** fix this, so nobody wastes time on them:

- **Key rotation (`rekek`) does not help.** It re-wraps the *same* key value under a new
  master key, so old backups still decrypt unless you also destroy the old master-key
  generation.
- **A live streaming replica is not the problem.** It converges on the shred. Only
  *snapshots* and *delayed* replicas are backup-class copies.

> The previous version of this document listed an F4 test "confirm a restored backup cannot
> decrypt". That assertion is false and would have given false confidence. F4 in section 7
> is corrected to prove the *gap* (a pre-shred restore still decrypts) and then prove the
> operational mitigation actually closes it.

---

## 6. Hardening before production (does not block staging)

### 6.1 Production key backend (#3)

The design promises AWS KMS or HashiCorp Vault. Today **only the Vault provider exists**;
the `aws-kms` mentions in the code are comments, not an implementation. Decide:

- **Go with Vault** (a provider already ships), or
- **Write an `AwsKmsKeyProvider`** if the rental deploys on AWS. It is about the same size
  as [`vault_key_provider.ts`](src/services/vault_key_provider.ts).

Do not run production on the `env` provider: its master key is derived from `APP_KEY`, so
anyone who has the app config can re-derive it (an honest, documented limit).

### 6.2 Disaster recovery: the key-loss paradox (#4)

The power of crypto-shredding is also its danger. **If you lose the master key (Vault dies
without high availability, or someone deletes the transit key), every encrypted record for
that tenant is gone forever.** This is the nature of the design, not a defect. You need:

- Vault in high-availability mode with a backed-up keyring, or AWS KMS with multi-region
  keys.
- A written runbook for "key backend is down": today all reads of encrypted fields fail
  closed (correct), which means those parts of the app stop working until the backend
  returns. Know this in advance.

Note the tension with section 5.3: the master key surviving is what makes reads work and
what makes DR possible, and it is *also* what lets a pre-shred backup resurrect data. The
two are the same fact seen from opposite sides. Deliberately destroying an old master-key
generation is the strongest way to make a shred reach old backups, but it is also the way
you can lose a whole tenant. Treat master-key destruction as a rare, audited, deliberate
operation.

### 6.3 Key rotation runbook (#5)

`tenant:crypto:rekek` works but needs a written procedure: when to rotate, how to manage
the rotation window (the `OLD_APP_KEY` variable for the `env` provider, or Vault's
`transit/keys/<key>/rotate`), and who runs it. Without a runbook, rotation is postponed
forever and loses its point.

---

## 7. Phased plan with owners

| Phase | What | Owner | Blocks |
|---|---|---|---|
| **F1 — Unblock RTBF** | Minimal `erasabilityResolver` in the rental + the category rules table (5.1). Test: shredding `marketing` succeeds, shredding `identity-docs` in retention is refused. | owner + sister | RTBF cannot run at all |
| **F1.5 — Cancellable shred (grace window)** | Add a `pending_shred_at` column (distinct from `shredded_at`); the shred command marks the row and keeps `wrapped_dek` intact, while reads immediately fail closed (the customer sees the data as erased). A scheduled sweeper physically nulls the key only after a grace period (`config.crypto.shredGraceMs`, default 72h), running the two-phase WORM audit at that point. Add `tenant:crypto:shred:cancel` to clear the marker while the key still exists. Reuse the scheduler seam + `TenantQueueService`, serialized on the per-tenant operation lock. | security + owner | operator trust (not a compliance/storage gate) |
| **F2 — Plaintext leak audit** | Trace every place a passport touches plaintext: AI, logs, error bodies, query strings/access logs, external processors (email/PDF/tickets/payment metadata), the blind index, queues/caches (5.2). Close or document each. | security specialist | erasure completeness |
| **F3 — Reconcile erasure with backups** | Set backup and WAL/PITR retention shorter than the erasure deadline; define a post-shred purge/re-dump policy; decide whether to destroy old master-key generations after the window; extend the policy to clones and replica snapshots (5.3). | security + owner + ops | the shred is reversible until this is closed |
| **F4 — Prod key backend + DR** | Choose Vault vs AWS KMS; if KMS, write the provider. HA + "backend down" runbook (6.1, 6.2). | security + owner | production |
| **F5 — Real end-to-end proof (corrected)** | E2E against real Postgres + Vault: encrypt a passport, shred, confirm the *live* read throws. Then **prove the gap**: restore a backup taken before the shred and confirm it STILL decrypts. Then prove the F3 mitigation (backup expiry or master-key-generation destruction) closes it. RLS with `NOBYPASSRLS`. | security specialist | demonstrated confidence |
| **F6 — Rotation runbook + honest docs** | Done in this pass: the false backup claims in `ARCHITECTURE.md` (I6, T8, §6.6, §10, §1) and the `crypto_service.ts` shred docstring were corrected. Remaining: write the rekek runbook and the operator-facing honest limits. | sister | 1.0 |

Compliance gates before you promise erasure: **F1, F2, F3.** Operator-safety hardening:
**F1.5.** Production and confidence: **F4, F5.** Documentation truth: **F6.** F1.5 and the
immediate shred are already compliant on their own; F1.5 is about surviving human error and
a rogue operator, not about the law.

---

## 8. Questions for the security specialist

Hand him these so he arrives to validate and attack, not to reverse-engineer:

1. Is the DEK granularity per `(customer × category)` right for the rental's threat model,
   or do we want per-field keys?
2. **F2:** where does a passport touch plaintext outside crypto (AI, logs, query strings,
   emails, PDFs, tickets, payment metadata)? This audit decides whether the shred is real.
3. **F3:** what is our erasure deadline, and is backup + WAL retention shorter than it? Do
   we rely on backup expiry, or do we destroy the old master-key generation after a shred
   window? Which one is operationally realistic for us?
4. Is the `env` provider acceptable for staging, or do we require Vault/KMS from day one?
5. What is the HA/backup strategy for the master key so losing Vault does not erase every
   tenant?
6. Is a blind index over the passport acceptable given the documented equality/frequency
   leak, or should that field not be searchable?

## 9. Questions for legal / CNDP (crypto cannot answer these)

These answers **fill in the category rules table** in section 5.1 and set the erasure
deadline in section 5.3. Without them, F1 and F3 cannot be completed correctly.

1. Which categories are erasable on request, and which carry a mandatory retention window
   under Ley 09-08 (and GDPR for EU customers)?
2. How long must a signed rental contract be retained? (The design assumes an example of
   10 years.)
3. Is a passport number a `legal-obligation` category (kept during retention even under
   RTBF), and for how long?
4. What is the maximum time we are allowed to take to complete an erasure request (the
   erasure deadline)? This sets how long a pre-shred backup may keep living.

## 10. The honest limits (what crypto does NOT promise)

State these plainly so nobody oversells "we are GDPR compliant" (compliance is a property
of your company's practices, never of a library):

- It **does not decide** what is lawful to delete. That is your category rules table
  (5.1), backed by legal advice.
- It **does not erase plaintext copies outside Lasagna**: application logs, error bodies,
  URLs in access logs, external processors, or a search-index column the rental did not
  null (5.2).
- It **does not reach copies of the key that predate the shred**: a database backup, WAL
  archive, replica snapshot, tenant clone, or query log written before the shred contains
  the wrapped key, and the surviving master key can re-open it. Erasure is complete only
  once those expire or the old master-key generation is destroyed (5.3).
- The **search index leaks equality and frequency** to anyone who can read the database
  (they see which rows share a value and how often). This is the standard trade-off of
  searchable encryption; opt a field in deliberately.
- The **`env` provider does not separate the root of trust**: its key is derived from
  `APP_KEY`. Use a real KMS/Vault in production.
- **Do not put PII in the shred audit reason.** The WORM shred ledger stores
  tenant/subject/category and a free-text `reason`, and it is immutable by design (it
  survives tenant purge). A passport written into the `reason` string is an un-erasable
  copy in the one place built never to be deleted. Use a category or code, never the value.

> **Doc-truth note:** `ARCHITECTURE.md` used to overstate the backup guarantee (I6, §6.6,
> §10) by claiming a shred reaches "every backup" and that "a restored dump still cannot be
> decrypted". That is only true for backups taken *after* the shred. Those sentences (and
> the matching `crypto_service.ts` docstring) were corrected in this pass. The engine's
> behavior was always honest; the prose now matches it.

## 11. References

- Design rationale: [`ARCHITECTURE.md`](ARCHITECTURE.md) (its backup claims in I6, T8,
  §6.6, §10 were corrected in this pass to match the engine's real behavior).
- The encryption + shred engine: [`src/services/crypto_service.ts`](src/services/crypto_service.ts)
- The wrapped-key store (`shredLive`): [`src/services/pg_wrapped_dek_store.ts`](src/services/pg_wrapped_dek_store.ts)
- The wrapped-key table DDL + the `_live_has_key` CHECK (inline in the migration): [`tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts`](tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts)
- The erasability hook type: [`src/types/erasability.ts`](src/types/erasability.ts)
- Dev key backend: [`src/services/env_key_provider.ts`](src/services/env_key_provider.ts)
- Production key backend (Vault): [`src/services/vault_key_provider.ts`](src/services/vault_key_provider.ts)
- Config surface: [`src/define_config.ts`](src/define_config.ts)
- Shred command: [`src/commands/tenant_crypto_shred.ts`](src/commands/tenant_crypto_shred.ts)
- Rotation command/service: [`src/services/rekek_service.ts`](src/services/rekek_service.ts)
- Backup engine (the `pg_dump` scope that captures the wrapped key): [`packages/backup/src/services/backup_service.ts`](../backup/src/services/backup_service.ts)

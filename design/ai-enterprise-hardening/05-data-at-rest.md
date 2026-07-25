# 05 Data at rest: per-tenant memory DEK + embeddings content encryption (Wave 5, gated)

This is the one wave the bundle designs in full but does NOT flip on. It ships two seams and their
validated config fields, both defaulting to exactly today's behavior, plus the cost-out that tells a
host what turning either on actually buys and costs. Enabling `tenant-dek` memory or `encryptContent`
embeddings on any host is a SEPARATE go with its own review (README open decision 4, and `00-foundation.md`
§5 stands: this touches erasure and stays pending the operator's legal counsel). Wave 5 delivers the
plumbing so that go is a config flip, not a code change under deadline.

## 1. What already ships

**Conversation memory is sealed, but under one fleet-wide key.** Every stored exchange is `enc_v2`
ciphertext produced by the injected `ConversationMemoryDeps.encryptMemory`
(`conversation_memory_service.ts:86`), which the provider wires to the kernel's
`writeSecret(plain, 'aiConversationMemory')` (`ai_provider.ts:172`); the read is
`decryptMemory` (`conversation_memory_service.ts:88`) bound to `readSecret(cipher, 'aiConversationMemory')`
(`ai_provider.ts:173`). The secret class `AI_MEMORY_SECRET_CLASS = 'aiConversationMemory'`
(`constants.ts:177`) gives memory its own HKDF context, so a blob cannot be decrypted as any other
secret class. Both seams are SYNC today (`(plaintext: string) => string`), and neither carries a
`tenantId`. The AES key underneath is `HKDF-SHA256(APP_KEY, …)`: one key for the whole fleet. A
rotation is handled by re-encrypting under the new APP_KEY with a grace read of the old one,
`decryptMemoryPrevious` (`conversation_memory_service.ts:94`) wired to
`decryptWithAppKey(cipher, OLD_APP_KEY, …)` only when `OLD_APP_KEY` is set (`ai_provider.ts:174-177`).

**Embeddings content and metadata sit plaintext at rest.** The vector store inserts `content` and
`metadata` as literal text/jsonb binds (`vector_store_service.ts:162-165`), and `search` reads them
straight back (`vector_store_service.ts:207-217`). The row dedup key `content_hash` is a SHA-256 over
`(model, content)` computed by the caller (`embedding_ingestion_service.ts:121`, def
`:255-258`) BEFORE the row is built, so it hashes caller plaintext and is independent of how the
column is stored. The `metadata` column is queryable: a `RetrievalFilter`-resolved metadata ACL
compiles to `AND metadata @> ?::jsonb` (`vector_store_service.ts:395`), and `source`/`actor` are
plaintext columns that key purge and ACL (`deleteBySource :249`, `countByActor :229`, the `source IN`
scope `:392`).

**The crypto satellite already owns per-tenant field encryption, and core already owns the seam it
needs.** `CryptoService.encryptField` / `decryptField` (`crypto_service.ts:130`, `:149`) resolve a DEK
per `(subject × category)` from the wrapped-DEK store, unwrap it through the pluggable `KeyProvider`
(`key_provider.ts:45` `wrapDek`, `:55` `unwrapDek`), and seal/open with core's
`sealV2WithKey`/`openV2WithKey` (`crypto.ts:213`, `:236`, `DEK_BYTES = 32` at `:195`) so the DEK is
the domain separator and a shred makes the value irrecoverable. Those two field methods are ASYNC.
Core exposes `sealV2WithKey`/`openV2WithKey` precisely so a caller can seal under an injected DEK and
stay crypto-primitive-free. crypto is NOT a peer dependency of the AI package today
(`package.json:83-86` lists only `saas-tenancy` and `@adonisjs/core`).

## 2. The gap

Two concrete failures, both stated in `00-foundation.md` §3:

1. **One key compromise exposes every tenant's memory.** Because the AES key is
   `HKDF(APP_KEY)` and APP_KEY is fleet-wide, an APP_KEY leak (or a backup of the Redis lists plus the
   env) decrypts every tenant's conversation history at once. There is no per-tenant blast-radius
   boundary, and a GDPR erasure of one tenant's memory is a `SCAN`+`UNLINK` of live keys, not a
   cryptographic guarantee: a leaked backup taken before the purge is still readable.

2. **A raw text-column dump of the embeddings table hands over content and metadata in the clear.**
   A read replica snapshot, a `pg_dump`, or a mis-scoped analytics connection reads `content` and
   `metadata` as plaintext. The vector column is the deeper exposure (it inverts to source text), but
   the plaintext text columns are the trivial one.

## 3. The root-cause mitigation

### 3a. Per-tenant memory DEK (the seam carries `tenantId` and goes async)

The root change is to the memory seam itself. `encryptMemory`/`decryptMemory` gain a `tenantId`
parameter and become async:

```ts
encryptMemory: (tenantId: string, plaintext: string) => Promise<string>
decryptMemory: (tenantId: string, ciphertext: string) => Promise<string>
decryptMemoryPrevious?: (tenantId: string, ciphertext: string) => Promise<string>
```

Every call site already has the tenant id in hand: `append` takes `tenantId`
(`conversation_memory_service.ts:245`) and calls `encryptMemory` at `:267`; `#decodeExchange` receives
`tenantId` (`:327`) and calls `decryptMemory` at `:330`. `append` is ALREADY async
(`:245-287`), so it only gains an `await`. The one real ripple is that `#decodeExchange`
(`:327-355`) goes sync→async, which makes `load`'s per-element loop (`:214-226`) `await` each decode
(bounded by `maxTurns`, default 20, so O(20) awaits per load, not a hot fan-out). `mintSession` and
`resolveSession` are pure HMAC and are untouched.

**The service stays mode-agnostic.** It never learns whether the key is the APP_KEY or a tenant DEK;
it calls the async seam with the tenant id and gets ciphertext back. The MODE is a provider-boot
wiring decision driven by a new validated field `AIMemoryConfig.encryption?: 'app-key' | 'tenant-dek'`
(default `DEFAULT_AI_MEMORY_ENCRYPTION = 'app-key'`, one of `AI_MEMORY_ENCRYPTION_MODES`). On
`'app-key'` (the default) the provider wires `encryptMemory` to `Promise.resolve(writeSecret(plain, 'aiConversationMemory'))`:
byte-identical to today's ciphertext, plus a resolved promise. On `'tenant-dek'` it wires a resolver
that fetches the per-tenant DEK via `CryptoService` and seals with `sealV2WithKey(plain, dek, keyId)`,
so the service still never touches a crypto primitive and the DEK path reuses the frozen `enc_v2`
envelope.

**DEK scope: one subject, a dedicated category (the `AI_MEMORY_SECRET_CLASS` idiom carried to the DEK
side).** crypto DEKs are `(subject × category)`-scoped (`crypto_service.ts:130`). The recommended
default is `subject = tenantId` and `category = AI_MEMORY_DEK_CATEGORY` (`'ai:conversation-memory'`),
i.e. ONE memory DEK per tenant. That is the same domain-separation idiom the secret class gives on the
app-key path, moved to the DEK: a memory DEK cannot open an embeddings value or a domain field value.
The per-actor-subject alternative (`subject = userMac`) is noted in §6.

**Fail posture — boot: FAIL-CLOSED.** crypto stays an OPTIONAL peer (no new hard dependency;
`package.json:83-86` unchanged). If `encryption: 'tenant-dek'` is selected but the crypto binding is
absent, the provider routes through the `fail()` choke in `validate_config.ts` (emitting
`guard.ai_config_invalid`), aborting boot. A host that asks for tenant-DEK memory without crypto
installed must not silently fall back to the fleet key. The seam also gets the standard
`typeof deps.encryptField === 'function'` boot check (`00-foundation.md` §4). Selecting `'tenant-dek'`
carries no `acknowledge*` escape hatch, because it is a STRENGTHENING of the default, not a relaxation
of one.

**Fail posture — request read: FAIL-SAFE, unchanged.** `load` fails safe today (a store or decrypt
failure degrades to `[]`, bounded by the TTL: `:200-236`). The DEK path preserves that exactly. A
`dek_missing` on read (the tenant's memory DEK was shredded) degrades to empty memory, which is the
DESIRED outcome of a crypto-shred: the conversation history is now cryptographically gone, and the
chat proceeds statelessly. A transient KeyProvider outage (KMS down) also degrades to empty, matching
today's store-outage posture, and increments a new `AI_MEMORY_DEK_UNAVAILABLE_METRIC` (distinct from
the existing `AI_MEMORY_UNDECRYPTABLE_METRIC` so a KMS outage is not mistaken for a botched rotation).
`append` stays best-effort (`:283-286`): a DEK-provision failure on write emits the existing
`AI_MEMORY_PERSIST_FAILED_METRIC` and never throws.

**The DEK cache is bounded, not a leaky Map.** `CryptoService.#liveDek` hits the wrapped-DEK store on
every call (`crypto_service.ts:362-368`, a `store.findLive` DB read plus an unwrap); with no cache,
the tenant-DEK memory path would add a DB round-trip to every turn. The memory-DEK resolver therefore
holds a bounded LRU keyed by `(tenant, category)`, capped at `DEFAULT_AI_DEK_CACHE_MAX` entries
(Not host-tunable; the same bounded-map discipline `00-foundation.md` §1 requires, evicting
least-recently-used rather than growing without limit). Cardinality is one entry per tenant on the
recommended single-subject scope. The cache is INVALIDATED on two signals:

- **on `SubjectShredded` (load-bearing).** A cached DEK that outlived its shred would keep decrypting
  memory after the operator believed it erased, defeating the entire point of crypto-shredding. This
  invalidation is what makes "a crypto shred makes memory cryptographically irrecoverable" true rather
  than aspirational.
- **on `tenant:crypto:rekek` (defensive).** A rekek rewraps the DEK envelope under a new KEK
  generation without changing the DEK plaintext, so a stale cached DEK would still decrypt correctly;
  the cache is dropped anyway so the in-process view never diverges from the persisted envelope
  generation.

**What this retires.** On the `tenant-dek` path, KEK rotation is handled INSIDE the KeyProvider:
`unwrapDek` unwraps under the current or a previous KEK generation during the rotation window
(`key_provider.ts:47-55`), and `tenant:crypto:rekek` re-wraps DEKs as an O(rows) cursor walk. So the
`decryptMemoryPrevious` / `OLD_APP_KEY` re-encrypt grace machinery (`ai_provider.ts:174-177`) is
UNUSED on this path: there is no per-blob re-encryption on rotation, and `decryptMemoryPrevious` is
wired only on the `app-key` path. That is a net reduction in moving parts, not an addition.

### 3b. Embeddings content-at-rest (the vector stays plaintext, the text columns encrypt)

The vector column CANNOT be encrypted: ANN search runs `embedding <=> ?::vector`
(`vector_store_service.ts:208-209`) and there is no distance metric over ciphertext. Only the `content`
and (optionally) `metadata` text columns encrypt, behind two validated fields
`AIEmbeddingConfig.encryptContent?` and `AIEmbeddingConfig.encryptMetadata?`, both default false
(`DEFAULT_AI_EMBEDDING_ENCRYPT_CONTENT = false`, `DEFAULT_AI_EMBEDDING_ENCRYPT_METADATA = false`).

The store gains an optional injected seal/open seam, mirroring the memory design so the store stays
crypto-primitive-free:

```ts
sealContent?: (tenantId: string, plaintext: string) => Promise<string>   // absent ⇒ plaintext (today)
openContent?: (tenantId: string, ciphertext: string) => Promise<string>
```

**Insert seals before bind, through the Wave-1 `#exec` boundary.** The `content` value (and, if
`encryptMetadata`, the serialized `metadata`) is sealed to `enc_v2` ciphertext before it becomes a
bind in the `INSERT` (`vector_store_service.ts:161-165`), which after Wave 1 funnels through the single
raw-query `#exec` boundary. `content_hash` is UNAFFECTED: it hashes caller plaintext at
`embedding_ingestion_service.ts:121`, upstream of storage, so `ON CONFLICT (source, content_hash) DO
NOTHING` dedup keeps working across a re-ingest whether or not the column is encrypted. **Search
decrypts O(limit) rows** after the ANN query returns (`vector_store_service.ts:212-217`): the index
scan is unchanged, and only the `limit` returned rows (default 8, max 50 per `MAX_RETRIEVAL_LIMIT`)
are opened. The embeddings DEK is `subject = tenantId`, `category = AI_EMBEDDINGS_DEK_CATEGORY`
(`'ai:embeddings-content'`), distinct from the memory category.

**HARD CONSTRAINT: `encryptMetadata` is mutually exclusive with metadata-scoped retrieval.** The
metadata ACL compiles to `metadata @> ?::jsonb` (`vector_store_service.ts:395`), a containment
predicate that cannot run over ciphertext. So `content`-only is the safe default. When
`encryptMetadata` is on, a `RetrievalScope` of `kind: 'metadata'` arriving at `scopeClause` is refused
fail-closed with `guard.ai_embedding_metadata_scope_conflict`, rather than scanning ciphertext and
silently returning zero rows (a silent-wrong-answer is worse than a loud refusal). **`source` and
`actor` stay plaintext by design**: they key purge and ACL (`deleteBySource :249`, `countByActor
:229`, `source IN` scope `:392`), and encrypting them would break document-scoped retrieval and
per-user erasure.

**Fail posture — insert: FAIL-CLOSED.** With `encryptContent` on, a seal failure (DEK provision fails,
KeyProvider down) FAILS the ingest as a typed 503; it must NEVER write plaintext into a column the
operator declared encrypted. **Fail posture — search: FAIL-SAFE.** A row whose content will not open
(the tenant corpus was shredded, or one row is corrupt) is dropped from the result set with
`AI_EMBEDDING_CONTENT_UNDECRYPTABLE_METRIC`, consistent with the memory read posture: a shredded-tenant
corpus should read empty, not 500.

### Named constants introduced (all in `constants.ts`)

| Constant | Value / meaning | Tunable |
|---|---|---|
| `DEFAULT_AI_MEMORY_ENCRYPTION` | `'app-key'` (the union default) | `config.ai.memory.encryption` |
| `AI_MEMORY_ENCRYPTION_MODES` | `['app-key', 'tenant-dek']` (the validated union) | no |
| `AI_MEMORY_DEK_CATEGORY` | `'ai:conversation-memory'` (the DEK `CategoryKey`) | no |
| `AI_EMBEDDINGS_DEK_CATEGORY` | `'ai:embeddings-content'` | no |
| `DEFAULT_AI_DEK_CACHE_MAX` | bounded LRU entry cap for the DEK cache | Not host-tunable |
| `DEFAULT_AI_EMBEDDING_ENCRYPT_CONTENT` | `false` | `config.ai.embedding.encryptContent` |
| `DEFAULT_AI_EMBEDDING_ENCRYPT_METADATA` | `false` | `config.ai.embedding.encryptMetadata` |
| `AI_MEMORY_DEK_UNAVAILABLE_METRIC` | `'ai_memory_dek_unavailable'` | — |
| `AI_EMBEDDING_CONTENT_UNDECRYPTABLE_METRIC` | `'ai_embedding_content_undecryptable'` | — |

New guards, each following the four-step act (`00-foundation.md` §2):
`guard.ai_embedding_metadata_scope_conflict` (the mutual-exclusion refusal) and the boot refusal routed
through `guard.ai_config_invalid` (tenant-DEK selected, crypto absent).

## 4. The cost-out

| Feature | Perf cost | Blast-radius benefit | Optional crypto peer | Why gated |
|---|---|---|---|---|
| **Per-tenant memory DEK** (`encryption: 'tenant-dek'`) | Symmetric seal/open cost unchanged (same AES-256-GCM primitive). +1 DB round-trip (`store.findLive` + `unwrapDek`) on a COLD tenant's first touch; ~0 steady-state (bounded LRU). The seam goes async, rippling `#decodeExchange` and `load`'s O(maxTurns≤20) loop. | One key per tenant instead of one per fleet: an APP_KEY leak no longer decrypts every tenant's history. A crypto-shred (`SubjectShredded`) makes that tenant's memory cryptographically irrecoverable, even from a pre-purge backup. Retires the `OLD_APP_KEY` re-encrypt grace. | crypto, optional. Absent + selected ⇒ fail-closed boot abort. | Touches the memory HOT PATH (every turn read/written), so the async ripple and the DB-round-trip-on-cold-tenant land on the request path; the DEK cache correctness is load-bearing for erasure. Deserves its own drive. |
| **Embeddings content-at-rest** (`encryptContent` / `encryptMetadata`) | Seal on insert (once per chunk). Decrypt O(limit) rows per search (≤50), AFTER the ANN index scan, so the index cost is unchanged. `content_hash` dedup unaffected (hashes caller plaintext). `encryptMetadata` DISABLES metadata-scoped retrieval. | Defends a raw text-column dump (`pg_dump`, replica snapshot, mis-scoped analytics read) of `content`/`metadata`. Per-tenant DEK, so a shred erases the tenant's readable corpus text. | crypto, optional. `encryptContent` on + seal failure ⇒ fail-closed 503 insert (never plaintext). | The RESIDUAL: the plaintext vector remains approximately invertible to source text, so this defends the text column but NOT vector inversion. Plus the hot-path decrypt-O(limit), the optional peer, and the metadata-retrieval trade-off. Physical isolation stays the real embedding control. |

The wave is gated for the union of four reasons: the memory change lands on a hot path with an async
ripple and a cold-tenant round-trip; the embeddings change carries an unfixable vector-inversion
residual; both add an optional peer whose absence must fail closed; and both change the erasure story,
which `00-foundation.md` §5 holds pending the operator's legal counsel.

## 5. Acceptance tests

Red-first, one failing spec stating the gap before each fix, per `00-foundation.md` §4.

**Memory, default-off preserved.** With no `encryption` field, the stored Redis element and every
existing memory regression spec are byte-identical to today. This is the behavior-preserving proof
(`00-foundation.md` §1): the async seam is proven correct by the EXISTING specs staying green after
the sync→async change, not by new assertions restating it.

**Memory, tenant-DEK path.** With `encryption: 'tenant-dek'`, a written turn's stored element opens
with the tenant's memory DEK (`openV2WithKey`) and does NOT open under the `aiConversationMemory`
secret class; a subsequent `CryptoService.shred` of that tenant's `AI_MEMORY_DEK_CATEGORY` DEK makes
`load` degrade to `[]` (irrecoverable), incrementing no error metric (a shred is expected, not a
fault). A boot spec asserts `encryption: 'tenant-dek'` with the crypto binding absent fails closed
through `fail()` (`guard.ai_config_invalid`). A resolver spec asserts the DEK cache serves steady-state
reads with zero `store.findLive` calls after the first, and that a `SubjectShredded` event evicts the
entry.

**Embeddings, default-off preserved.** With both flags false, `content`/`metadata` are plaintext and
existing vector-store specs stay green.

**Embeddings, encrypted path.** With `encryptContent`, the DB `content` column is `enc_v2` ciphertext,
`content_hash` is unchanged (a re-ingest is still deduped), and `search` returns decrypted plaintext
`content`. A spec asserts that a `kind: 'metadata'` scope arriving while `encryptMetadata` is on is
refused with `guard.ai_embedding_metadata_scope_conflict`, not silently zero rows. A spec asserts a
seal failure on insert fails the ingest (503) and writes NO row.

## Honesty bound

- **This does not defend against vector inversion.** The embedding vector stays plaintext (it must, to
  be ANN-searchable) and is approximately invertible to source text. `encryptContent` defends a raw
  `content`/`metadata` column dump; it does NOT defend the vector. Physical isolation remains the real
  embedding control, which is why `rowscope-pg` is refused outright for embeddings
  (`vector_store_service.ts:344-349`). This restates `00-foundation.md` §5.
- **The tenant DEK raises the at-rest bar, not the runtime bar.** To decrypt a turn, the DEK is
  unwrapped into app-process memory. A live-process compromise (a running node with the DEK cached)
  still sees decrypted turns. The win is at-rest blast-radius (per-tenant not per-fleet) and
  crypto-shred erasability, not runtime confidentiality.
- **`source` and `actor` stay plaintext by design.** A content-column dump still reveals WHICH
  principal and WHICH document produced each row (they key purge and ACL), just not the row's text.
- **Boot fail-closed covers a MISSING peer, not a WEAK KeyProvider.** Selecting `tenant-dek` with the
  dev-grade `env` provider (`APP_KEY`-derived KEK) is a weaker root of trust than a KMS/Vault provider;
  the choice of KeyProvider is the operator's, and the boot check cannot judge its strength.
- **These mechanisms do not decide lawfulness.** Compliance is a property of the operator, and the
  erasure/retention surface here stands PENDING LEGAL ADVICE (`00-foundation.md` §5).

## Open decisions owned by the user

1. **Enablement (recommended default: stay OFF).** Ship the seams and config defaulting to today's
   behavior (`app-key` memory, plaintext embeddings). Flipping any host to `tenant-dek` or
   `encryptContent` is a separate go with its own review (README decision 4). This is the recommended
   and executed posture for Wave 5.
2. **DEK granularity (recommended: per-tenant single subject).** `subject = tenantId`, one memory DEK
   and one embeddings DEK per tenant: minimal wrapped-DEK rows, minimal cache cardinality, and
   crypto-shred as the tenant-level "make it irrecoverable" control. The alternative,
   `subject = userMac` for memory (and `subject = actorHash` for embeddings), buys CRYPTOGRAPHIC
   per-user erasure on top of the existing per-user `SCAN`/`actor`-column purge, at the cost of a
   wrapped-DEK row per `(user × category)` and a larger DEK cache. Choose per-actor only if
   cryptographic per-user erasure is a stated requirement.
3. **Memory-read posture on DEK-unavailable (recommended: fail-SAFE).** Degrade to empty memory,
   matching today's store-outage posture, because a shredded DEK SHOULD read empty. The alternative
   (fail-closed 503 on a transient KeyProvider outage) trades availability for a louder signal;
   `AI_MEMORY_DEK_UNAVAILABLE_METRIC` already makes the outage observable without failing the request.
4. **crypto as an optional vs required peer (recommended: OPTIONAL).** Keep crypto out of the AI
   package's hard dependencies; boot fails closed only when `tenant-dek` is actually selected without
   it. The alternative (a hard peer) simplifies the boot check but forces the crypto install on every
   AI host, including those that never enable at-rest DEKs.
5. **Embeddings `encryptMetadata` (recommended: leave FALSE, content-only).** Content-only keeps
   metadata-scoped retrieval working. Enabling `encryptMetadata` disables it (the `metadata @> ?::jsonb`
   predicate cannot run over ciphertext) and is enforced fail-closed at the scope boundary; turn it on
   only when the host has no metadata-ACL retrieval and metadata secrecy is worth that loss.

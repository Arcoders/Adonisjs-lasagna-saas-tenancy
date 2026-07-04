---
title: Crypto satellite
description: Field-level encryption for Lasagna — per-(subject × category) data keys wrapped under a pluggable KeyProvider, a deterministic search HMAC, and O(1) crypto-shredding, composed on the kernel isolation, secrets and WORM-audit rails.
---

# Crypto

`@adonisjs-lasagna/crypto` is the field-level encryption satellite for Lasagna. It
encrypts sensitive tenant columns at rest under a key hierarchy that makes a
GDPR/CNDP "right to erasure" an O(1) operation: destroy one small key and the data
it sealed is gone, with no table scan and no vacuum. It is the keystone of the
data-protection satellites (vault stores encrypted blobs on the same key
hierarchy, governance carries the policy), and it composes the kernel rails it
needs rather than laying parallel track: physical placement comes from the
isolation driver (I1), the sealing primitive is the kernel's `enc_v2` envelope,
and the shred audit rides the shared append-only WORM ledger.

crypto is a **mechanism, not a policy**. It carries no category registry, no
consent model and no retention schedule. It only needs to know which KeyProvider
backs the key-encryption key and which processing category each encrypted field
belongs to. Whether a subject *may* be erased is a decision it consults governance
for, and refuses the erasure when governance is absent.

## The key hierarchy

Three layers, so erasure stays cheap and blast radius stays small:

- A **KeyProvider** derives a per-tenant **KEK** (key-encryption key). The built-in
  `env` provider derives it from `APP_KEY`; a production host binds AWS KMS or
  HashiCorp Vault instead (see [Custom KeyProvider](#custom-keyprovider)).
- Each `(subject × category)` pair gets its own random **DEK** (data-encryption
  key). The DEK is stored only **wrapped** under the tenant's KEK, in a per-tenant
  `crypto_wrapped_deks` table. There is no plaintext DEK anywhere at rest (**I2**).
- A field value is sealed under its DEK with the kernel's authenticated `enc_v2`
  envelope. The ciphertext carries a non-secret `keyId` tag pointing at the
  wrapped-DEK row, never the key itself.

Erasing a subject's data is then just tombstoning its wrapped-DEK row: null the
`wrapped_dek`, and every value sealed under that DEK is permanently unrecoverable
(**I6**). This is crypto-shredding, and it is what makes per-subject erasure a
constant-time write instead of a destructive scan.

<Callout type="info" title="Where the wrapped-DEK table lives (I1)">
The store never hardcodes a schema. It asks the active isolation driver
`tableLocation(tenant)` where the tenant's wrapped-DEK rows physically live and
runs its SQL there, so the same code is correct on `schema-pg`, `database-pg` and
`connection`. Under `rowscope-pg` the table is shared and separated by a
`tenant_id` scope column plus row-level security (see
[Rowscope placement](#rowscope-placement)). A raw query whose tenant differs from
the active scope is refused before it runs (the satellite ContextSeal).
</Callout>

## Install

```bash
npm install @adonisjs-lasagna/crypto @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/crypto
```

`@adonisjs-lasagna/saas-tenancy` (the core), `@adonisjs/core` and `@adonisjs/redis`
are required peers. `node ace configure` registers the provider in `adonisrc.ts`
and publishes the central rowscope migration stub (you only run it under
`rowscope-pg`, see below).

The per-tenant `crypto_wrapped_deks` table ships **inside** the package as a
per-tenant migration, so it lands in whatever placement the active driver reports
when you run the tenant migration pass:

```bash
node ace tenant:migrate        # applies the wrapped-DEK table into each tenant's placement
```

New tenants provisioned after install pick it up automatically through the
provision hook. Crypto-shredding additionally needs the shared
`backoffice.worm_ledger` table (the append-only audit the core WORM ledger ships);
publish and run it once if you have not already.

## Configure

Declare a `crypto` block in `config/multitenancy.ts`. It is validated eagerly at
boot (`assertCryptoConfig`), so a bad shape fails at startup rather than at the
first encrypted write.

```ts
// config/multitenancy.ts
import { defineCryptoConfig } from '@adonisjs-lasagna/crypto'

// inside your multitenancy config:
crypto: defineCryptoConfig({
  // Which KeyProvider backs the KEK. Default 'env' (dev-grade, KEK from APP_KEY).
  // A production host names its own 'aws-kms' / 'hashicorp-vault' here.
  keyProvider: 'env',

  // The encrypted-field registry: which category each field belongs to, and
  // whether it also carries a blind index for equality search.
  fields: {
    'renter.passportNumber': { category: 'identity', searchable: true },
    'renter.licenseNumber': { category: 'identity' },
  },

  // The governance erasability gate crypto consults before a shred (I7). Absent
  // means every shred is refused: crypto never decides erasability itself.
  // erasabilityResolver: myGovernance.resolveErasability,
}),
```

Every field belongs to a **category**, which is the unit a DEK is scoped to and
the unit governance reasons about (retention, legal hold). A `searchable` field
additionally gets a deterministic HMAC so you can query it by equality (see
[Searchable fields](#searchable-fields-blind-index)).

## Encrypt a field: two surfaces

crypto exposes two ways to encrypt, both backed by the same seam. Pick per use
case; you can mix them in one app.

### Model decorators (the ergonomic surface)

Attach `@encrypted` / `@searchable` to a Lucid model and compose the
`withEncryptedFields` mixin. Encryption happens transparently in the model
lifecycle: the plaintext is sealed before insert/update and decrypted after
load, so your application code reads and writes plain properties.

```ts
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { TenantBaseModel } from '@adonisjs-lasagna/saas-tenancy'
import { encrypted, searchable, withEncryptedFields } from '@adonisjs-lasagna/crypto'

export default class Renter extends compose(TenantBaseModel, withEncryptedFields) {
  @column({ isPrimary: true })
  declare id: string

  // Sealed at rest under the 'identity' DEK for this row's subject.
  @encrypted({ category: 'identity', subject: (row) => row.id })
  declare passportNumber: string

  // A keyed HMAC of the plaintext, for equality search. Never serialized.
  @searchable({ category: 'identity', from: (row) => row.passportNumber })
  declare passportNumberIndex: string | null
}
```

The `subject` resolver decides whose DEK seals the value (here the renter's own
id). The `@searchable` column stores the blind index computed from the plaintext
source; it defaults to `serializeAs: null` so the HMAC never leaks in a JSON
response.

<Callout type="warning" title="Model hooks cover the model write path only">
The decorators seal on the Lucid create/update lifecycle, so they cover
`Model.save()` and friends. A write that bypasses the model (`Model.query().update()`,
a raw `INSERT`, or the `*Quietly` variants) writes plaintext. The
[ciphertext CHECK](#seal-the-write-path-t5) closes that gap at the database
layer, which is the only place that catches every write path.
</Callout>

### EncryptedRepository (the explicit surface)

For non-model data or an auditable, explicit call site, resolve
`EncryptedRepository`. The caller passes only `(subject, category)` and the value;
the tenant is resolved from the active scope, fail-closed if there is none.

```ts
import { EncryptedRepository } from '@adonisjs-lasagna/crypto'

const repo = await app.container.make(EncryptedRepository)

const sealed = await repo.encrypt(renterId, 'identity', passportNumber)
const plain = await repo.decrypt(renterId, 'identity', sealed)
const index = await repo.blindIndex('identity', passportNumber) // for a WHERE lookup
```

Use the decorators for fields that live on a tenant model, and the repository when
the value is not a model column or when you want the encryption call to be
explicit in the code path.

## Searchable fields (blind index)

Encrypted values cannot be queried directly, so an equality lookup uses a
**blind index**: a deterministic keyed HMAC of the normalized plaintext, stored in
a host-owned column. The index key comes from the KeyProvider (not a DEK), so it
is constant across rows and **survives a shred**, and the value is normalized
(NFKC + trim, opt-in case-fold) so logically equal inputs collide.

You store the HMAC in your own indexed column and query it:

```ts
const index = await repo.blindIndex('identity', inputPassport)
const renter = await Renter.query().where('passportNumberIndex', index).first()
```

<Callout type="warning" title="A blind index leaks equality and frequency">
By construction, identical plaintexts produce identical HMACs, so a database
reader can see which rows share a value and how often each value occurs. That is
the whole point (it is what makes the column searchable), and it is why indexing
is opt-in per field. Do not mark a field searchable unless equality search is
worth that leak. It is never a substitute for encryption: the HMAC is one-way and
carries no key.
</Callout>

## Seal the write path (T5)

The single reliable way to guarantee a column never holds plaintext, across raw
SQL, the query builder and the `*Quietly` model paths, is a database `CHECK`
constraint that requires the `enc_v2:` (or migration-window `enc_v1:`) prefix.
crypto ships the helper; you apply it per encrypted column in your own migration:

```ts
import { encryptedColumnCheckSql } from '@adonisjs-lasagna/crypto'

export default class extends BaseSchema {
  async up() {
    this.schema.raw(encryptedColumnCheckSql({ table: 'renters', column: 'passport_number' }))
  }
}
```

Now any write that stores a non-ciphertext value in that column is rejected by
Postgres itself, whatever code path issued it. This is the control that actually
closes the plaintext-write gap; the model decorators cannot, because they never
see a raw or query-builder write. The check is intentionally **not** applied to
`crypto_wrapped_deks.wrapped_dek`, whose format is KeyProvider-specific (a KMS or
Vault provider stores an opaque blob, not an `enc_v2` frame).

## Crypto-shredding (erasure)

`crypto.shred(tenant, subject, category)` performs an O(1) erasure by tombstoning
the subject's wrapped-DEK row. It is gated and audited, because destroying key
material is irreversible:

1. **Governance gate first (I7).** crypto consults the configured
   `erasabilityResolver`. If governance is absent, or the category is under a legal
   hold or still in a retention window, the shred is **refused** and nothing is
   destroyed. crypto never decides erasability on its own.
2. **Two-phase WORM audit.** A `PENDING` row is appended to the append-only WORM
   ledger before the delete (a failure here aborts, nothing is destroyed), and a
   `COMMITTED` row after. The audit records a one-way hash of the subject, never
   the subject itself.

Run it from the CLI, with a preview first:

```bash
node ace tenant:crypto:shred --tenant=<id> --subject=<id> --category=identity --dry-run
node ace tenant:crypto:shred --tenant=<id> --subject=<id> --category=identity --force
```

`--dry-run` runs the governance gate and preconditions and reports whether the
shred *would* proceed, without deleting or auditing. `--force` gates the
irreversible real run. A refusal (legal hold, governance absent, unaudited) exits
non-zero with the reason, not a stack trace.

## Rotate the KEK (`tenant:crypto:rekek`)

KEK rotation re-wraps every live DEK under the current KEK generation. It never
re-encrypts field data: the DEK bytes and the row `keyId` tag are unchanged, so
sealed values keep decrypting, and the cost is O(number of DEKs), not O(number of
values).

```bash
node ace tenant:crypto:rekek --tenant=<id> --dry-run
node ace tenant:crypto:rekek --tenant=<id>
```

For the `env` provider, an `APP_KEY` rotation uses a dual-key read window: set
`OLD_APP_KEY` to the previous key alongside the new `APP_KEY`, run `rekek`, and
drop `OLD_APP_KEY` once no DEK is still wrapped under the old generation. Each
unwrap attempt is a strict open of a DEK envelope, so the read window never
weakens the fail-closed decrypt posture.

## Custom KeyProvider

The `env` provider is dev-grade: the KEK is a pure function of `APP_KEY`, which
gives destruction granularity but no root-of-trust separation. Production binds a
real KMS. Implement the `KeyProvider` contract, then register it on the
`KeyProviderRegistry` in your own provider and name it in `config.crypto.keyProvider`:

```ts
// providers/kms_provider.ts
import { KeyProviderRegistry } from '@adonisjs-lasagna/crypto'

export default class KmsProvider {
  async boot() {
    const registry = await this.app.container.make(KeyProviderRegistry)
    registry.register(new MyKmsKeyProvider()) // name: 'aws-kms'
  }
}
```

```ts
// config/multitenancy.ts
crypto: defineCryptoConfig({ keyProvider: 'aws-kms', /* ... */ }),
```

An unregistered provider name is fail-closed at resolve time: the platform never
falls back to a weaker or shared key.

## Rowscope placement

Under `rowscope-pg` every tenant shares one schema, so the wrapped-DEK table is a
single shared table rather than one per tenant. Because a DEK is stored only
wrapped under a per-tenant KEK, reading another tenant's `wrapped_dek` bytes is
useless without that tenant's KEK, so crypto **can** live in a shared table (unlike
the AI vector store, whose embeddings are invertible and which refuses rowscope).

`node ace configure` publishes the central
`create_crypto_wrapped_deks_rowscope` migration stub. It creates the shared table
with a `tenant_id` scope column, a per-`(tenant_id, subject_id, category)` partial
unique index, and a FORCED row-level-security policy. The store always adds an
`AND tenant_id = ?` predicate and stamps the column on insert (the primary,
always-on isolation), and when the driver reports RLS is on it sets the
transaction-local GUC so its own SQL passes the policy. To wire it, publish and
run the stub, set `isolation.rowScopeRls: true`, add `'crypto_wrapped_deks'` to
`isolation.rowScopeTables`, and run the app role without `BYPASSRLS`.

## Guard events

Every fail-closed refusal in the satellite (a shred refused for legal hold, an
unaudited shred, a KeyProvider that is unavailable, a scope mismatch on a raw
query, an invalid config) emits the kernel's public `IsthmusGuardTripped` event
before it throws, with `guard.crypto_*` ids inside the documented taxonomy.

```ts
// start/events.ts
import { IsthmusGuardTripped } from '@adonisjs-lasagna/saas-tenancy/events'

emitter.on(IsthmusGuardTripped, ({ payload }) => {
  if (payload.id.startsWith('guard.crypto_')) {
    alerting.notify(payload.severity, payload.event, payload.tenantId)
  }
})
```

Crypto trips are counted per tenant on the `crypto_guard_rejections` metric. See
the [Isthmus reference](/reference/isthmus) for the taxonomy.

<Callout type="warning" title="Honest limits">
The `env` KeyProvider derives the KEK from `APP_KEY`, so it gives per-subject
destruction but no separation between the root of trust and the app. Use a KMS or
Vault provider in production. A blind index leaks equality and frequency by design
(above). The ciphertext CHECK is what seals the raw-SQL write path; the model
decorators cover the model path only. And a shred destroys key material
irreversibly, which is exactly why it is gated on governance and audited to the
WORM ledger.
</Callout>

## Read next

- [Security guide](/guides/security) for the isolation model the encryption
  composes on and the `tenant:secrets:reencrypt` rotation path.
- [Stability matrix](/reference/stability) for what the release-candidate label
  promises.
- [CLI reference](/reference/commands#crypto) for the `tenant:crypto:*` commands.

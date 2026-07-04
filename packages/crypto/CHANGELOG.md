# Changelog

All notable changes to `@adonisjs-lasagna/crypto` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0]

**Introduced the crypto satellite at release candidate**: field-level encryption for
Lasagna, built on a key hierarchy that makes per-subject erasure an O(1) operation.
It is the keystone of the data-protection satellites, and composes the kernel
isolation, secrets and WORM-audit rails rather than laying parallel track.

Added:
- **`CryptoConfig` config block** (`defineCryptoConfig`), validated eagerly at boot
  (`assertCryptoConfig`). Names the KeyProvider that backs the KEK (default `env`),
  registers each encrypted field's category and whether it carries a blind index,
  and optionally wires governance's erasability gate.
- **The key hierarchy.** A pluggable `KeyProvider` derives a per-tenant KEK; each
  `(subject × category)` pair gets a random DEK stored only wrapped under the KEK in
  a per-tenant `crypto_wrapped_deks` table (no plaintext DEK at rest, I2); a field is
  sealed under its DEK with the kernel's authenticated `enc_v2` envelope. The
  built-in `EnvKeyProvider` derives the KEK from `APP_KEY`; a host binds AWS KMS,
  HashiCorp Vault or a custom provider on the `KeyProviderRegistry`.
- **Placement follows the isolation driver (I1).** `PgWrappedDekStore` asks the
  active driver `tableLocation(tenant)` and never hardcodes a schema, so it is
  correct on `schema-pg`, `database-pg` and `connection`. Under `rowscope-pg` the
  table is shared and separated by a `tenant_id` scope column plus a FORCED
  row-level-security policy (shipped as a central migration stub). A raw query whose
  tenant differs from the active scope is refused before it runs (the satellite
  ContextSeal).
- **Two encryption surfaces**, both on the same seam: transparent `@encrypted` /
  `@searchable` model decorators via the `withEncryptedFields` mixin, and the
  explicit `EncryptedRepository` facade (`encrypt` / `decrypt` / `blindIndex` /
  `shred`) that resolves the tenant from the active scope, fail-closed with none.
- **Deterministic search (blind index).** A keyed HMAC of the normalized plaintext
  (NFKC + trim, opt-in case-fold), keyed from the KeyProvider so it is constant
  across rows and survives a shred. Opt-in per field, because it leaks equality and
  frequency by design.
- **Ciphertext CHECK (`encryptedColumnCheckSql`).** A DB-level constraint requiring
  the `enc_v2:` / `enc_v1:` prefix, the one control that seals the raw-SQL,
  query-builder and `*Quietly` write paths the model decorators cannot see.
- **Crypto-shredding.** `CryptoService.shred` and `tenant:crypto:shred` tombstone a
  subject's wrapped-DEK row (O(1) erasure, I6), gated on governance's erasability
  resolver (absent or a legal hold refuses, I7) and two-phase audited to the shared
  append-only WORM ledger (PENDING before, COMMITTED after). Per-tenant operation
  lock and a partial unique index keep the live DEK singular under concurrency (I10).
- **KEK rotation.** `RekekService` and `tenant:crypto:rekek` re-wrap every live DEK
  under the current KEK generation without re-encrypting any field data, with a
  dual-key (`OLD_APP_KEY`) read window for the `env` provider.
- **Isthmus guard registry.** Every fail-closed refusal emits the kernel's public
  `IsthmusGuardTripped` event with a `guard.crypto_*` id, counted per tenant on the
  `crypto_guard_rejections` metric.
- **Structural guards** (`check-crypto-invariant-{1,2,3,4,5,8,9,10}`) pinning the
  invariants at review time, plus a real-Postgres integration suite across every
  placement.

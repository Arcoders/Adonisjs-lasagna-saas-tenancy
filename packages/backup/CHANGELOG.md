# Changelog

All notable changes to `@adonisjs-lasagna/backup` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-07-10

Shipped as `experimental` at `0.1.0` (see the stability matrix).
Backup also became a first-class satellite (a `lasagnaSatellite` manifest at the
frozen Satellite ABI, an `adonisjs.configure` hook, and discovery), so it installs
and self-describes like the other satellites. The per-tenant backup, restore, clone,
SQL-import, and retention tooling was extracted from `@adonisjs-lasagna/saas-tenancy`
so the `pg_dump`/`pg_restore` machinery versions independently. It depends on the
core as a peer (`>=0.3.0 <1.0.0`); `@adonisjs/redis` (queue jobs) and
`@aws-sdk/client-s3` (S3 mirror) are optional peers.

- **Destructive operation lock fails closed (behaviour change).** When the Redis
  coordination lock is unreachable, `restore` / `clone` / `import` now refuse to
  run unserialised (503) rather than proceeding without the lock, since an
  unserialised overlap can corrupt a schema. The read-only `backup` still fails
  open. Opt the destructive ops back into the legacy fail-open behaviour with
  `backup.lockFailOpenOnDestructive: true`.
- **SQL import refuses unsafe literal rewrites.** `tenant:import` now refuses (not
  just warns) when the schema rewrite would alter a `<source schema>.` occurrence
  inside a SQL string literal, which would corrupt that value. Pass `--force` to
  override, or re-export with `pg_dump --inserts`. `--dry-run` still only reports.
- **Symlink rejection.** Backup files are `lstat`-checked before being handed to
  `pg_restore` / `psql`; a symlink in the backup directory is rejected.
- **At-rest encryption doctor check.** A new `backup_encryption` doctor check
  reminds operators to enable S3 SSE or local disk encryption (the package does
  not encrypt dumps itself).
- **S3 peer checked at boot.** When `backup.s3.enabled` is true, the provider
  verifies the optional `@aws-sdk/client-s3` peer at boot instead of failing
  partway through the first upload.
- **Coverage gate added** (`.c8rc.json`, `check-coverage: true`).

### Fixed

- **Failed dumps leave no half-written artifact.** `BackupService.backup()` now
  unlinks the partial `.dump` and rethrows when `pg_dump` dies mid-write (a dropped
  DB connection, a vanished schema, a full disk). Previously an unrestorable
  half-dump survived on disk, where a later `restore` or a retention sweep could
  pick it up as if it were a real backup.
- **`typesVersions` for the `/provider` and `/commands` subpaths.** Those subpaths
  were declared in `exports` but had no matching `typesVersions` entries, so a
  consumer on `node10`-style module resolution could not resolve their type
  declarations. Added the missing entries (mirroring core).
- **README refreshed for this release.** Badge corrected to experimental;
  configure-first install documented; the required `@adonisjs/queue` peer, both the
  `backup_recency` and `backup_encryption` doctor checks, and a commands/flags table
  are now in the README.

### Added

- `BackupService`: per-tenant `pg_dump`/`pg_restore` with an optional S3 mirror, schema-name
  guarding via `assertSafeIdentifier`, and `BackupMetadata` results.
- `BackupRetentionService`: tier-based intervals and `keepLast` with S3 purge awareness.
- `CloneService`: tenant cloning with a correct integer-sequence reset.
- `SqlImportService`: SQL file import with a lazily-loaded logger; throws `PsqlNotAvailableError`
  when `psql` is absent. **Strict (all-or-nothing) is the default**: the first failing statement
  aborts and rolls back the whole import — `tenant:import --continue-on-error` (or
  `strict: false` on the service) opts into per-statement savepoints, which can leave a partial
  import. The schema rewriter surfaces `warnings` whenever it touched a `<source>.` substring
  inside a SQL string literal (it cannot avoid the rewrite without a full parser, but it refuses
  to be silent about it); re-export with `pg_dump --inserts` or a matching schema name if those
  values matter.
- Jobs `BackupTenant`, `RestoreTenant`, `CloneTenant`, and the `tenant:backup*` / `tenant:clone`
  / `tenant:import` ace commands.
- `backupRecencyCheck`: a doctor check the provider registers into the core `DoctorService`.

### Migration from core

These services, jobs, and commands moved here. Update imports to `@adonisjs-lasagna/backup`
and register `@adonisjs-lasagna/backup/provider` and `@adonisjs-lasagna/backup/commands` in
`adonisrc.ts` (this is what registers the `backup_recency` doctor check and the backup queue
jobs). The `BackupMetadata` / `CloneResult` result types stay in
`@adonisjs-lasagna/saas-tenancy/types`.

**Stability: experimental.** The API carries no semver promise and may change in any
minor, with the honest caveat that a correction forced by the pending security review
or production mileage lands with a loud changelog entry. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/reference/stability.md).

# Changelog

All notable changes to `@adonisjs-lasagna/backup` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-08

Initial standalone release. The per-tenant backup, restore, clone, SQL-import, and retention
tooling was extracted from `@adonisjs-lasagna/saas-tenancy` so the `pg_dump`/`pg_restore`
machinery versions independently. It depends on the core as a peer (`^1.0.0`); `@adonisjs/redis`
(queue jobs) and `@aws-sdk/client-s3` (S3 mirror) are optional peers.

**Stability: experimental.** The API is covered by tests but may change in a minor release.
Pin the version and read this changelog before upgrading. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/docs/stability.md).

### Added

- `BackupService`: per-tenant `pg_dump`/`pg_restore` with an optional S3 mirror, schema-name
  guarding via `assertSafeIdentifier`, and `BackupMetadata` results.
- `BackupRetentionService`: tier-based intervals and `keepLast` with S3 purge awareness.
- `CloneService`: tenant cloning with a correct integer-sequence reset.
- `SqlImportService`: SQL file import with a lazily-loaded logger; throws `PsqlNotAvailableError`
  when `psql` is absent.
- Jobs `BackupTenant`, `RestoreTenant`, `CloneTenant`, and the `tenant:backup*` / `tenant:clone`
  / `tenant:import` ace commands.
- `backupRecencyCheck`: a doctor check the provider registers into the core `DoctorService`.

### Migration from core

These services, jobs, and commands moved here. Update imports to `@adonisjs-lasagna/backup`
and register `@adonisjs-lasagna/backup/provider` and `@adonisjs-lasagna/backup/commands` in
`adonisrc.ts` (this is what registers the `backup_recency` doctor check and the backup queue
jobs). The `BackupMetadata` / `CloneResult` result types stay in
`@adonisjs-lasagna/saas-tenancy/types`.

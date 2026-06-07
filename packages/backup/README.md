# @adonisjs-lasagna/backup

Per-tenant backup, restore, clone, SQL import and retention for
[`@adonisjs-lasagna/saas-tenancy`](https://www.npmjs.com/package/@adonisjs-lasagna/saas-tenancy).

[![Stability: experimental](https://img.shields.io/badge/stability-experimental-E0A106)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/stability)

> **Experimental.** This satellite works and is covered by tests, but it is not part of the 1.x stability promise: its surface may change in a minor release. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/stability).

This satellite was extracted from the core package. It carries everything that
shells out to `pg_dump` / `pg_restore` / `psql`, talks to S3, and copies tenant
schemas:

- `BackupService` — `pg_dump`/`pg_restore` a tenant schema, with optional S3
  upload/download and a Redis + on-disk metadata sidecar.
- `BackupRetentionService` — tiered retention (interval + keep-last) over a
  tenant's archives.
- `CloneService` — provision a new tenant schema and copy row data from a source.
- `SqlImportService` — load a `.sql` dump into a tenant schema (transactional, or
  via `psql` for `COPY … FROM stdin` blocks).
- The `BackupTenant`, `RestoreTenant`, `CloneTenant` queue jobs.
- The `tenant:backup`, `tenant:backup:list`, `tenant:restore`, `tenant:import`,
  `tenant:clone`, `tenant:backups:run` ace commands.
- A `backup_recency` doctor check, registered into the core `DoctorService` by
  this package's provider.

The tenant-lifecycle hook contexts (`before/after backup|restore|clone`) and the
`TenantBackedUp` / `TenantRestored` / `TenantCloned` events stay in the core —
they are part of the core lifecycle contract. The `backup` config block and its
`BackupMetadata` / `CloneResult` result types also live in the core
(`@adonisjs-lasagna/saas-tenancy/types`); this package imports and re-exports them.

## Install

```bash
npm i @adonisjs-lasagna/backup
```

`@adonisjs/redis` and `@aws-sdk/client-s3` are optional peers — install them only
if you use the Redis metadata cache or S3 archival.

## Wire it up

Register the provider and the commands in `adonisrc.ts`, alongside the core
provider:

```ts
providers: [
  // ...
  () => import('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'),
  () => import('@adonisjs-lasagna/backup/provider'),
],
commands: [
  () => import('@adonisjs-lasagna/saas-tenancy/commands'),
  () => import('@adonisjs-lasagna/backup/commands'),
],
```

The provider registers the backup jobs with the `@adonisjs/queue` Locator and the
`backup_recency` check with the core `DoctorService`. Configure the `backup` block
in `config/multitenancy.ts` (storage path, `pgConnection`, optional `s3` and
`retention`) — the type lives in the core config.

# @adonisjs-lasagna/backup

Per-tenant backup, restore, clone, SQL import and retention for
[`@adonisjs-lasagna/saas-tenancy`](https://www.npmjs.com/package/@adonisjs-lasagna/saas-tenancy).

[![Stability: release candidate](https://img.shields.io/badge/stability-release_candidate-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: release candidate.** The API is frozen under the 1.x promise, with the honest caveat that a correction forced by the pending security review or production mileage may land in a 1.x minor with a loud changelog entry. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

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
- The `backup_recency` and `backup_encryption` doctor checks, registered into the
  core `DoctorService` by this package's provider.

The tenant-lifecycle hook contexts (`before/after backup|restore|clone`) and the
`TenantBackedUp` / `TenantRestored` / `TenantCloned` events stay in the core —
they are part of the core lifecycle contract. The `backup` config block and its
`BackupMetadata` / `CloneResult` result types also live in the core
(`@adonisjs-lasagna/saas-tenancy/types`); this package imports and re-exports them.

## Install

```bash
npm i @adonisjs-lasagna/backup @adonisjs-lasagna/saas-tenancy @adonisjs/queue
node ace configure @adonisjs-lasagna/backup
```

`@adonisjs-lasagna/saas-tenancy` (the core) and `@adonisjs/queue` are required
peers — the backup jobs are dispatched through the queue. `@adonisjs/redis` and
`@aws-sdk/client-s3` are optional peers — install them only if you use the Redis
metadata cache or S3 archival. Backup ships no migrations of its own.

## Wire it up

`node ace configure @adonisjs-lasagna/backup` registers the provider and commands
in `adonisrc.ts`. The provider registers the backup jobs with the `@adonisjs/queue`
Locator and the `backup_recency` + `backup_encryption` checks with the core
`DoctorService`. Configure the `backup` block in `config/multitenancy.ts` (storage
path, `pgConnection`, optional `s3` and `retention`) — the type lives in the core
config.

## Commands

| Command | What it does | Key flags |
|---|---|---|
| `tenant:backup` | Back up one or all active tenants synchronously | `--tenant/-t` (repeatable) |
| `tenant:backup:list` | List available backups for one or all tenants | `--tenant/-t` |
| `tenant:restore` | Restore a tenant schema from a backup file | `--tenant/-t` (req), `--file` (req) |
| `tenant:import` | Import a `.sql` dump into a tenant schema | `--tenant/-t` (req), `--file/-f` (req), `--schema-replace`, `--dry-run`, `--force`, `--continue-on-error` |
| `tenant:clone` | Provision a new tenant and copy the source's rows | `--source/-s` (req), `--name/-n` (req), `--email/-e` (req), `--schema-only`, `--clear-sessions` |
| `tenant:backups:run` | Run scheduled backups + retention across tenants (cron-safe) | `--tenant/-t`, `--force`, `--dry-run`, `--no-retention` |

See the [backup guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/backup)
for the full flag reference.

## Full documentation

<https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/backup>

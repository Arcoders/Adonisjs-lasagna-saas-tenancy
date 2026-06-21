---
title: Backup
description: Per-tenant backup, restore, clone and SQL import with pg_dump/pg_restore, optional S3, a fail-closed operation lock, and safety guards on import.
---

# Backup

Per-tenant backup, restore, clone, SQL import and retention. It shells out to the
PostgreSQL client tools (`pg_dump` / `pg_restore` / `psql`) against each tenant's
own schema, stores dumps on local disk or S3, and serialises overlapping
operations with a per-tenant lock.

## Configuration

Backup operates on the tenants' existing schemas, so it ships **no migrations**.
Install it, run its configure hook (which registers the provider and commands),
and add the config block:

```bash
npm install @adonisjs-lasagna/backup
node ace configure @adonisjs-lasagna/backup
npm install @aws-sdk/client-s3            # optional peer, only for the s3 storage driver
```

```ts
// config/multitenancy.ts
backup: {
  storagePath: app.tmpPath('backups'),
  metadataTtl: 60 * 60 * 24 * 30,
  pgConnection: {
    host: env.get('DB_HOST'),
    port: Number(env.get('DB_PORT')),
    user: env.get('DB_USER'),
    password: env.get('DB_PASSWORD', ''),
    database: env.get('DB_DATABASE'),
  },
  // s3: { enabled: true, bucket: env.get('BACKUP_S3_BUCKET'), region: env.get('AWS_REGION'),
  //   accessKeyId: env.get('AWS_ACCESS_KEY_ID'), secretAccessKey: env.get('AWS_SECRET_ACCESS_KEY') },
}
```

The `pg_dump` / `pg_restore` / `psql` binaries must be on the host's `PATH`. When
`s3.enabled` is true the provider checks the optional `@aws-sdk/client-s3` peer at
**boot** and fails fast with a clear error if it is missing, rather than letting
the first upload fail partway through a backup.

## Commands

```
tenant:backup        --tenant=<id>                 Dump one tenant's schema
tenant:backups:run                                 Back up every active tenant
tenant:backup:list   --tenant=<id>                 List a tenant's backups
tenant:restore       --tenant=<id> --file=<name>   Restore a dump into a tenant
tenant:clone         --source=<id> --dest=<id>     Clone one tenant's schema into another
tenant:import        --tenant=<id> --file=<f.sql>  Import a .sql dump into a tenant schema
```

## Safety model

Backup custodies tenant data, so the destructive paths are deliberately
conservative:

- **Fail-closed operation lock.** A per-tenant Redis lock serialises overlapping
  backup-family operations. The destructive operations (restore, clone, import)
  **fail closed** when Redis is unreachable: they refuse to run unserialised
  rather than risk corrupting a schema, surfacing a 503. The read-only `backup`
  fails open (a missed backup beats blocking every backup on a Redis blip). Opt
  the destructive ops back into the legacy fail-open behaviour with
  `backup.lockFailOpenOnDestructive: true`.
- **SQL import literal safety.** The importer rewrites `<source schema>.`
  references to the tenant schema. Without a full SQL parser it cannot tell an
  identifier from a string literal, so when a `<source>.` occurrence sits inside a
  string literal (which the rewrite would corrupt), `tenant:import` **refuses** the
  import. Re-export with `pg_dump --inserts` or a matching schema name, or pass
  `--force` to import anyway and accept the corruption. A `--dry-run` reports the
  same lines as warnings without refusing.
- **Symlink rejection.** Before handing a file to `pg_restore` / `psql`, the path
  is `lstat`-checked and a symlink is rejected, so a symlink planted in the backup
  directory cannot redirect a restore at an arbitrary file.
- **At-rest encryption advisory.** The package does not encrypt dumps itself.
  `tenant:doctor` includes a `backup_encryption` check that reminds you to enable
  bucket-level SSE (S3) or disk-level encryption and restrict the backup
  directory's permissions.

## Read next

- [Doctor](/docs/commands#doctor); the `backup_recency` and `backup_encryption` checks.
- [Deployment](/docs/deployment); the client-tool and storage requirements.
- [Production checklist](/docs/production-checklist); the hardening runbook before you ship.
- [Creating a satellite](/docs/cookbook/creating-a-satellite); how this package is built.

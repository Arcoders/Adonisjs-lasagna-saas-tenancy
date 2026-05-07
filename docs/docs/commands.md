---
title: Commands
description: 27 ace commands for provisioning, migrations, backups, doctor, exec-under-tenant, maintenance, REPL, and more.
---

# Commands

<Callout type="tip" title="Discovery">
Every command supports <code>--help</code>. List everything Lasagna
ships with: <code>node ace list:commands | grep -E 'tenant|backoffice|migration:tenant'</code>.
</Callout>

## Provisioning

| Command | What it does |
|---|---|
| `backoffice:setup` | Create the backoffice schema and run satellite migrations. Idempotent. |
| `tenant:create <name> <email>` | Insert a tenant row and queue `InstallTenant`. |
| `tenant:list` | List tenants with current status. `--all` includes soft-deleted. |
| `tenant:activate <id>` | Activate a suspended or failed tenant. |
| `tenant:suspend <id>` | Block all API access without dropping the schema. |
| `tenant:destroy <id>` | Soft-delete and tear down. `--force` skips prompt; `--keep-schema` preserves storage during retention. |

## Migrations

| Command | What it does |
|---|---|
| `migration:tenant:run` / `tenant:migrate` | Run pending migrations against one or all tenants. `--dry-run`, `--disable-locks`, `--verbose`. |
| `migration:tenant:rollback` / `tenant:migrate:rollback` | Roll back the last migration batch. |
| `tenant:migrate:fresh` | DROP and recreate per-tenant storage, then re-run migrations. **Destructive.** `--force`, `--seed`. |
| `tenant:seed` | `db:seed` per tenant. `--files` cherry-picks specific seeders, `--continue-on-error` keeps going. |

## Operations

| Command | What it does |
|---|---|
| `tenant:backup` | One-shot backup for one or all active tenants (synchronous). |
| `tenant:backups:run` | Cron-friendly: backs up tenants whose tier interval has elapsed, then applies retention. `--dry-run`, `--no-retention`. |
| `tenant:backup:list` | List available backups. |
| `tenant:restore --tenant=<id> --file=<name>` | Restore a tenant schema from a `.dump` file. |
| `tenant:import --tenant=<id> --file=<path>` | Import a `pg_dump` `.sql` file into a tenant schema. |
| `tenant:clone --source=<id> --name=<name> --email=<email>` | Provision a new tenant by cloning an existing one. `--schema-only`, `--clear-sessions`. |
| `tenant:queue:stats` | BullMQ queue statistics. |

## Doctor

`tenant:doctor` is the operational health command. Ten built-in
checks, `--fix` to auto-recover, `--json` for CI gates, `--watch`
for a live TUI.

<Terminal src="/casts/doctor.cast.json" />

```bash
# Run every check, table output
node ace tenant:doctor

# Limit to one tenant
node ace tenant:doctor --tenant=<id>

# Run a specific check; --check=list prints available checks
node ace tenant:doctor --check=schema_drift,backups

# Auto-fix what's fixable
node ace tenant:doctor --fix

# CI gate: exits non-zero if anything is unhealthy
node ace tenant:doctor --json

# Live dashboard, refreshes every 5 s
node ace tenant:doctor --watch --interval=5000
```

## Exec-under-tenant

```bash
# Run any ace command inside one or more tenant contexts
node ace tenant:exec list:routes
node ace tenant:exec --tenant=<id> make:migration users
node ace tenant:exec --status=active db:seed
```

| Flag | Purpose |
|---|---|
| `--tenant=<id...>` | Target one or more tenants. Omit to iterate every tenant. |
| `--status=<status...>` | Filter (`active`, `provisioning`, `suspended`, `failed`, `deleted`). |
| `--include-deleted` | Include soft-deleted in the iteration. |
| `--limit=<n>` | Stop after N tenants. |
| `--batch-size=<n>` | Cursor batch size (default 100). |
| `--continue-on-error` | Don't bail on a tenant failure. |
| `--dry-run` | Report which tenants would run. |

## Maintenance and impersonation

| Command | What it does |
|---|---|
| `tenant:maintenance <id>` | Toggle maintenance mode (independent of suspended). `--off` exits, `--message="…"` shows a custom 503 message. |
| `tenant:impersonate <tenantId> <userId>` | Issue an admin impersonation token. `--admin=<id>`, `--duration=<seconds>`, `--reason="…"`, `--path=<path>`. |

## Background tasks

| Command | What it does |
|---|---|
| `tenant:webhooks:retry` | Process pending webhook retries. Cron: `* * * * *`. |
| `tenant:metrics:flush` | Flush Redis metric counters to the database. Cron: `0 1 * * *`. |
| `tenant:purge-expired` | Drop schemas of soft-deleted tenants past their retention window. Cron: `0 3 * * *`. |

## REPL

```bash
node ace tenant:repl <tenantId>
```

Drops you into a REPL with `tenant`, `db`, `audit`, `metrics`, and
the rest of the satellite services preloaded against the chosen
tenant context.

## Read next

- [Doctor](/docs/commands#doctor); see above; the killer feature.
- [Cookbook](/docs/cookbook/); recipes that compose multiple
  commands.

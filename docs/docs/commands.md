---
title: Commands
description: The full set of ace commands for provisioning, migrations, backups, doctor, exec-under-tenant, maintenance, REPL, billing, and more.
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

The backup, restore, import, and clone commands register when
[`@adonisjs-lasagna/backup`](/docs/upgrade-to-1.0#backup-clone-restore-sql-import--adonisjs-lasagnabackup)
is installed and its provider + commands are wired in `adonisrc.ts`.

| Command | What it does |
|---|---|
| `tenant:backup` | One-shot backup for one or all active tenants (synchronous). |
| `tenant:backups:run` | Cron-friendly: backs up tenants whose tier interval has elapsed, then applies retention. `--dry-run`, `--no-retention`. |
| `tenant:backup:list` | List available backups. |
| `tenant:restore --tenant=<id> --file=<name>` | Restore a tenant schema from a `.dump` file. |
| `tenant:import --tenant=<id> --file=<path>` | Import a `pg_dump` `.sql` file into a tenant schema. All-or-nothing by default (the first error aborts and rolls everything back); `--continue-on-error` opts into per-statement savepoints, which can leave a partial import. Warns when the schema rewrite touches a string literal. |
| `tenant:clone --source=<id> --name=<name> --email=<email>` | Provision a new tenant by cloning an existing one. `--schema-only`, `--clear-sessions`. |
| `tenant:queue:stats` | BullMQ queue statistics. |
| `tenant:secrets:reencrypt` | Re-encrypt stored secrets (webhook signing secrets, SSO client secrets) after an `APP_KEY` rotation. Reads the previous key from `OLD_APP_KEY` (env only, never a flag); idempotent, supports `--dry-run`. Ships in core. See the [security guide](/security). |

## Doctor

`tenant:doctor` is the operational health command. Nine built-in
checks (plus `backup_recency` when the backup satellite is
installed), `--fix` to auto-recover, `--json` for CI gates,
`--watch` for a live TUI.

<Terminal src="/casts/doctor.cast.json" />

```bash
# Run every check, table output
node ace tenant:doctor

# Limit to one tenant
node ace tenant:doctor --tenant=<id>

# Run specific checks; --check=list prints available checks
node ace tenant:doctor --check=schema_drift,backup_recency

# Auto-fix what's fixable
node ace tenant:doctor --fix

# Confirm before fixing each check (per-check, not per-issue)
node ace tenant:doctor --fix --interactive

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

## Feature flags

| Command | What it does |
|---|---|
| `tenant:feature-flag:set <tenantId> <flag> <true\|false>` | Create or update a flag. `--config='<json>'`, `--expires-at=<iso>`. Needs Redis (busts the cache). |
| `tenant:feature-flag:get <tenantId> <flag>` | Print the stored row as JSON (or `null`). Reads the DB directly. |
| `tenant:feature-flag:list <tenantId>` | List a tenant's flags as a table, or `--json`. Reads the DB directly. |
| `tenant:feature-flag:delete <tenantId> <flag>` | Delete a flag. `--force` skips the confirmation prompt. Needs Redis. |

## Background tasks

| Command | What it does |
|---|---|
| `tenant:webhooks:retry` | Process pending webhook retries. Cron: `* * * * *`. |
| `tenant:metrics:flush` | Flush Redis metric counters to the database. Cron: `0 1 * * *`. |
| `tenant:purge-expired` | Drop schemas of soft-deleted tenants past their retention window. Cron: `0 3 * * *`. |

## Compliance

Tooling that helps you satisfy SOC2 / GDPR / ISO 27001 / HIPAA
controls. Full guide: [Compliance (SOC2 & GDPR)](/compliance).

| Command | What it does |
|---|---|
| `tenant:audit:export` | Export the immutable audit log as JSON or CSV (auditors, GDPR data access & portability). `--tenant=<id>` (omit for all), `--from=<iso>`, `--to=<iso>`, `--format=json\|csv`, `--out=<file>`. Streams — safe on huge histories. |
| `tenant:gdpr:anonymize <tenantId>` | Run your `config.compliance.anonymize` seam (GDPR Art.17 erasure-by-anonymization) and record it in the audit log. `--dry-run`, `--reason="…"`, `--force`. Fails loudly if the seam is unset. |
| `tenant:compliance:report` | Report posture by introspecting config + DB state (triggers, encryption, isolation, access gate, retention). `--framework=soc2\|gdpr\|iso\|hipaa\|all`, `--control=<id>` (`list` to enumerate), `--json`, `--strict` (exit 1 on action-needed, for CI). |

## Satellites

| Command | What it does |
|---|---|
| `tenant:satellite:remove <package>` | Print a safe checklist for removing a packaged satellite (the `adonisrc.ts` lines, its published migrations, its config block, the uninstall command). Read-only: it never edits `adonisrc.ts` or drops data — removal stays deliberate. The inverse of `node ace configure <package>`. |

## Billing

Available when `--with=billing` is configured. Full reference in the
[Billing satellite](/docs/satellites/billing#ace-commands).

| Command | What it does |
|---|---|
| `tenant:billing:sync` | Reconcile Stripe subscriptions with the local mirror; recovers from missed webhooks. Flags: `--dry-run`, `--tenant=<id>`, `--since=<iso>`, `--json`. Cron: `0 4 * * *`. |
| `tenant:billing:backfill` | Seed `tenant_plans` rows with the default plan for every tenant that doesn't have one. Flags: `--dry-run`, `--force`, `--plan=<name>`. |
| `tenant:billing:replay` | Re-dispatch a failed webhook event after the underlying issue is fixed. Flags: `--event-id=<evt>`, `--all-failed`. |
| `tenant:billing:cleanup` | Purge `stripe_processed_events` older than `webhook.idempotencyTtlDays`. Flag: `--batch-size=<n>`. Cron: `0 4 * * *`. |
| `tenant:billing:sweep` | Emit due trial-ending notices (the Paddle / Lemon Squeezy fallback for Stripe's native `trial_will_end`) and apply due grace-period dunning downgrades. Idempotent. Flag: `--batch-size=<n>`. Cron: `0 * * * *` (hourly). |
| `tenant:billing:doctor` | Diagnose Stripe config + recent webhook health. Exit 1 on any error (pipeline-friendly). Flag: `--json`. |
| `tenant:billing:test-webhook <event>` | Generate and POST a signed synthetic Stripe event. Flags: `--url=<url>`, `--object=<file>`. Useful in CI without `stripe listen`. |

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

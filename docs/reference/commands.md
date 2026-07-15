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
| `tenant:create <name> <email>` | Insert a tenant row and queue `InstallTenant`. `--admin=<id>` attributes the audit row to an operator (default: `system`). |
| `tenant:list` | List tenants with current status. `--all` includes soft-deleted. |
| `tenant:activate <id>` | Activate a suspended or failed tenant. `--admin=<id>` attributes the audit row (default: `system`). |
| `tenant:suspend <id>` | Block all API access without dropping the schema. `--admin=<id>` attributes the audit row (default: `system`). |
| `tenant:destroy <id>` | Soft-delete and tear down. `--force` skips prompt; `--keep-schema` preserves storage during retention; `--admin=<id>` attributes the audit row (default: `system`). If the schema drop fails after the soft-delete, the tenant is already unreachable and the orphan schema is reclaimable with `tenant:purge-expired --include-orphans`. |
| `tenant:reprovision <id>` | Re-run provisioning for a `failed` or stuck-`provisioning` tenant (idempotent `driver.provision`, then `active`). Unlike `tenant:activate` (which only flips status), this re-creates the schema. No-op on an active tenant; refuses a soft-deleted one. `--force`, `--admin=<id>`. |

## Migrations

| Command | What it does |
|---|---|
| `migration:tenant:run` / `tenant:migrate` | Run pending migrations against one or all tenants. `--dry-run`, `--disable-locks`, `--verbose`. |
| `migration:tenant:rollback` / `tenant:migrate:rollback` | Roll back the last migration batch. |
| `tenant:migrate:fresh` | DROP and recreate per-tenant storage, then re-run migrations. **Destructive.** `--force`, `--seed`. |
| `tenant:seed` | `db:seed` per tenant. `--files` cherry-picks specific seeders, `--continue-on-error` keeps going. |

## Operations

The backup, restore, import, and clone commands register when
[`@adonisjs-lasagna/backup`](/reference/upgrade-to-0.3#backup-clone-restore-sql-import--adonisjs-lasagnabackup)
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
| `tenant:secrets:reencrypt` | The full secret migration. Brings every stored secret (webhook signing secrets, SSO client secrets) to the current `APP_KEY` and its per-class context, covering both plaintext-era values and values still under the older shared context. Two axes in one idempotent pass: set `OLD_APP_KEY` (env only, never a flag) to also rotate the key, or leave it unset for a context-only migration. Mandatory before upgrading for any host that stores these secrets, since a legacy-context value now fails closed. Supports `--dry-run`. Ships in core. See the [security guide](/guides/security). |
| `tenant:webhooks:encrypt-secrets` | Narrower one-time helper: encrypt any PLAINTEXT webhook signing secrets at rest. It does not re-encrypt already-encrypted secrets under their per-class context, so it is superseded by `tenant:secrets:reencrypt` for the upgrade. Idempotent, supports `--dry-run`. |

## Supply chain

`lasagna:health-check` audits the app's supply chain: it runs `npm audit` over the
dependency tree and flags each installed satellite that ships a native addon (not
sandboxable by the worker Permission Model) or an install lifecycle script (the
vector `--ignore-scripts` blocks). It exits non-zero on a high or critical
advisory, so it doubles as a CI gate.

```bash
node ace lasagna:health-check
```

`plugin:doctor` diagnoses the installed plugin/satellite platform posture: Satellite
ABI compatibility of each installed satellite, native-addon sandbox risk, a stale or
typo'd `TRUSTED_SATELLITES` allowlist, whether the read-only firewall (`plugins.readOnly`)
is configured while untrusted plugins are installed, and which plugins hold declared
(consent-gated) permissions. It exits non-zero on any error, so it doubles as a CI gate. It does not
re-check manifest↔spec coherence. That is the `check-plugin-permissions` build guard.

```bash
node ace plugin:doctor
node ace plugin:doctor --json
```

## Doctor

`tenant:doctor` is the operational health command. Nine built-in
checks (plus `backup_recency` and `backup_encryption` when the backup
satellite is installed), `--fix` to auto-recover, `--json` for CI gates,
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

## pgvector provisioning

For hosts using the vector store (embeddings), the PostgreSQL `vector`
extension must exist before any migration declares a `vector(N)` column.
`CREATE EXTENSION` needs a privileged role, so it runs under a separate
provisioning connection (`isolation.provisionConnectionName`), never the app's
request-serving role. The extension is installed into a dedicated `extensions`
schema, which `schema-pg` tenant connections append to their `search_path` after
the tenant's own schema, so a bare `vector(N)` column and its operators resolve
while `public` (which holds central-connection data) stays off the tenant path,
keeping physical tenant isolation (I1) intact. A hand-rolled tenant model that
registers its own connection must append that schema too (see the demo's
`app/models/backoffice/tenant.ts`).

| Command | What it does |
|---|---|
| `tenant:vector:provision` | Install the pgvector extension idempotently, into the dedicated `extensions` schema, under the privileged provisioning connection. Dispatched by driver: once on the shared database for `schema-pg`/`rowscope-pg`, per tenant database for `database-pg` (honouring `--tenant`). Run it before any embeddings migration; it doubles as the backfill for existing databases. `--dry-run` previews. |

The opt-in `pgvector_extension` doctor check verifies the app role is not a
superuser and that the extension is present in the `extensions` schema where
embeddings resolve it. Register it with
`doctorService.register(pgvectorExtensionCheck)`, then it runs under
`tenant:doctor --check=pgvector_extension`.

The requirement is **ordering, not locking**: provision before you migrate a
`vector(N)` column, and let the doctor check catch a missing extension. You do
not need to serialise the two commands. `tenant:vector:provision` and
`tenant:migrate` touch disjoint objects (the database-level `vector` extension
versus a tenant's own schema and `adonis_schema` ledger), and `CREATE EXTENSION
IF NOT EXISTS` is idempotent, so PostgreSQL's own catalog locks make a concurrent
run safe without an application-level lock.

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
| `tenant:maintenance <id>` | Toggle maintenance mode (independent of suspended). `--off` exits, `--message="…"` shows a custom 503 message, `--admin=<id>` attributes the audit row (default: `system`). |
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
| `tenant:metrics:rollup` | Recompute the per-tenant monthly rollup of `tenant_metrics` for fast whole-month reporting. Idempotent. `--since=<YYYY-MM-DD>`, `--until=<YYYY-MM-DD>`. Cron: `0 2 1 * *` (after a month closes). |
| `tenant:purge-expired` | Drop schemas of soft-deleted tenants past their retention window. Cron: `0 3 * * *`. `--include-orphans` also drops schemas of soft-deleted tenants still within retention (recovers orphans from a failed `tenant:destroy`). |

## Compliance

Tooling that helps you satisfy SOC2 / GDPR / ISO 27001 / HIPAA
controls. Full guide: [Compliance (SOC2 & GDPR)](/guides/compliance).

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
[Billing satellite](/guides/satellites/billing#ace-commands).

| Command | What it does |
|---|---|
| `tenant:billing:sync` | Reconcile Stripe subscriptions with the local mirror; recovers from missed webhooks. Flags: `--dry-run`, `--tenant=<id>`, `--since=<iso>`, `--json`. Cron: `0 4 * * *`. |
| `tenant:billing:backfill` | Seed `tenant_plans` rows with the default plan for every tenant that doesn't have one. Flags: `--dry-run`, `--force`, `--plan=<name>`. |
| `tenant:billing:replay` | Re-dispatch a failed webhook event after the underlying issue is fixed. Flags: `--event-id=<evt>`, `--all-failed`. |
| `tenant:billing:cleanup` | Purge `billing_processed_events` older than `webhook.idempotencyTtlDays`. Flag: `--batch-size=<n>`. Cron: `0 4 * * *`. |
| `tenant:billing:sweep` | Emit due trial-ending notices (the Paddle / Lemon Squeezy fallback for Stripe's native `trial_will_end`) and apply due grace-period dunning downgrades. Idempotent. Flag: `--batch-size=<n>`. Cron: `0 * * * *` (hourly). |
| `tenant:billing:doctor` | Diagnose Stripe config + recent webhook health. Exit 1 on any error (pipeline-friendly). Flag: `--json`. |
| `tenant:billing:test-webhook <event>` | Generate and POST a signed synthetic Stripe event. Flags: `--url=<url>`, `--object=<file>`. Useful in CI without `stripe listen`. |
| `tenant:billing:dlq:list` | List dead-lettered (failed) webhook events. Read-only; pairs with `tenant:billing:replay`. Flags: `--json`, `--limit=<n>`. |
| `tenant:billing:pricing:validate` | Validate plan/price configuration against the provider. Exit 1 on error, so it gates CI. Flag: `--json`. |

## Reporting

Available when `--with=reporting` is configured. Full reference in the
[Reporting satellite](/guides/satellites/reporting).

| Command | What it does |
|---|---|
| `tenant:report:generate` | Generate and print a cross-tenant usage report. Flags: `--period=day\|week\|month`, `--since=<iso>`, `--until=<iso>`, `--top=<n>`, `--format=table\|json\|csv`, `--out=<file>`, `--extension=<name>` (run a registered report extension instead of the built-in). |

## AI

Available when `--with=ai` is configured. Full reference in the
[AI satellite](/guides/satellites/ai#audit).

| Command | What it does |
|---|---|
| `tenant:ai:audit:verify` | Re-walk the append-only AI audit hash chain and report the first tamper (a broken checksum, a `seq` gap, or a broken prev-link) that got past the DB triggers. Exit 1 on the first break, so it gates a cron or a post-incident check. Flags: `--tenant=<id>` (omit for all), `--json`. |
| `tenant:ai:purge` | Erase a tenant's AI data for GDPR: conversation memory, the response-cache epoch, and embeddings. Scopes: `--tenant=<uuid> --force` (all), `--tenant=<uuid> --principal=<id>` (one user, Art.17), `--tenant=<uuid> --source=<key>` (one document). `--dry-run` previews the counts and writes nothing; `--verify-chain` also re-walks the audit chain; `--actor=<id>` sets the audited operator. The immutable, non-PII audit chain intentionally survives. |

## Crypto

Available when `--with=crypto` is configured. Full reference in the
[Crypto satellite](/guides/satellites/crypto#crypto-shredding-erasure).

| Command | What it does |
|---|---|
| `tenant:crypto:shred` | Crypto-shred a subject's data for a category: tombstone its wrapped-DEK row so every value sealed under that DEK becomes unrecoverable (O(1) erasure, I6). Gated on governance (a legal hold or absent `erasabilityResolver` refuses, I7) and audited to the WORM ledger (PENDING before, COMMITTED after). Flags: `--tenant=<id> --subject=<id> --category=<key>`, `--dry-run` (runs the gate + preconditions, destroys nothing), `--force` (gates the irreversible run), `--json`. A refusal exits non-zero with the reason. |
| `tenant:crypto:rekek` | Rotate the KEK: re-wrap every live DEK under the current KEK generation, without re-encrypting any field data (the DEK bytes and `keyId` are unchanged, so sealed values keep decrypting; cost is O(number of DEKs)). Idempotent and resumable; a failed row is reported, not silently skipped. For the `env` provider, set `OLD_APP_KEY` (env only) alongside the new `APP_KEY` for the dual-key read window. Flags: `--tenant=<id>`, `--dry-run`, `--json`. Exit 1 if any DEK failed to re-wrap. |


## REPL

```bash
node ace tenant:repl <tenantId>
```

Drops you into a REPL with `tenant`, `db`, `audit`, `metrics`, and
the rest of the satellite services preloaded against the chosen
tenant context.

## Read next

- [Doctor](/reference/commands#doctor); see above; the killer feature.
- [Cookbook](/guides/cookbook/); recipes that compose multiple
  commands.

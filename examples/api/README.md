# Lasagna Multitenancy, the Reference API

A real, runnable AdonisJS v7 app that exercises every corner of `@adonisjs-lasagna/saas-tenancy`. The README in the root of the repo is the spec. This folder is the proof. Clone it, bring up the stack, and you have working curl recipes for schema isolation, lifecycle hooks, contextual logging, plans and quotas, the doctor, scheduled backups, soft delete, the admin REST API, MailCatcher email capture, the webhooks pipeline, the satellites (feature flags, branding, SSO), and a Japa e2e suite that runs the whole thing end to end.

If something in the package is broken, this app refuses to boot or the suite turns red. That is the whole point.

> **Only need basic schema isolation?** Start with the [five-minute quickstart](../../docs/start/quickstart.md). This app is the full feature surface; the quickstart is the smallest wiring that gets one tenant resolving.

## A Practical Recommendation

**Use this as a reference, not as a starting template.** Don't clone it and start deleting things. Instead:

1. Read the entire README once to understand the scope.
2. Identify the 2–3 features you actually need right now (e.g., schema isolation + quotas).
3. Copy only those specific parts into your project understanding every line as you go.
4. When you need webhooks, backups, or SSO, come back here and copy the next feature you need.

In short: this example is valuable because it proves the package works in production and teaches you how to use it correctly. But it's a flight manual, not a tourist brochure.

## What is in here

```
examples/api
├── adonisrc.ts              # providers, including @adonisjs/mail and vinejs
├── app
│   ├── controllers/demo     # thin: parse → validate → service → response
│   ├── listeners            # audit_listener (11 events) + tenant_welcome_listener
│   ├── mailers              # TenantWelcomeMail (fired on TenantActivated)
│   ├── middleware           # demo admin auth, tenant guard wiring
│   ├── models/backoffice    # Tenant + DemoMeta, getReadConnection override
│   ├── providers            # binds TenantRepository, DoctorService, registers listeners
│   ├── repositories         # Lucid backed TenantRepositoryContract
│   ├── services             # tenants_service + notes_service (controller-side logic)
│   └── validators           # VineJS schemas, one file per resource
├── config
│   ├── database.ts          # central + backoffice + tenant template
│   ├── mail.ts              # SMTP transport pointed at MailCatcher
│   └── multitenancy.ts      # the full config surface, every block exercised
├── database
│   ├── migrations/backoffice  # tenants + 8 satellite tables
│   ├── migrations/tenant      # per tenant schema migrations
│   └── seeders                # notes_seeder, used by tenant:seed
├── docker-compose.yml         # postgres 16, redis 7, pgAdmin, MailCatcher
├── scripts                    # e2e.sh and e2e.ps1 wrap docker + suite
└── tests
    ├── e2e                    # end-to-end specs, plus a hardening/ suite
    ├── fixtures               # demo-tenant.sql, used by import + restore
    └── bootstrap.ts
```

The split is deliberate: controllers stay under ~10 lines per method, business logic
lives in [app/services/](app/services/), input shape lives in [app/validators/](app/validators/)
(VineJS surfaces failures as `422` automatically), and event side-effects live in
[app/listeners/](app/listeners/) — registered from `AppProvider.ready()`, not from
`start/routes.ts`. The route file contains route declarations only,
with lazy class handlers so `@inject()`-decorated controllers pick up their
constructor dependencies from the IoC container.

## Run the whole suite

```bash
npm install --legacy-peer-deps
npm run test:e2e          # bash, mac, linux, git-bash on windows
npm run test:e2e:win      # native PowerShell variant
```

That command does five things:

1. Brings up `docker compose` (postgres 16, redis 7, MailCatcher, pgAdmin) and waits for each container's health check.
2. Runs `node ace backoffice:setup`, which creates the `backoffice` schema and applies the eight satellite migrations (tenants, audit logs, webhooks, deliveries, branding, SSO, feature flags, metrics).
3. Probes MailCatcher's HTTP API. If it isn't up the suite still runs, but the mail tests skip with a clear message rather than failing.
4. Runs the Japa e2e suite (a few seconds on a developer laptop, longer on a CI runner). Backups, restore, import, and clone tests skip gracefully when `pg_dump`, `pg_restore`, or `psql` aren't on PATH.
5. Tears the stack down with `docker compose down -v`. Pass `--keep` (or `-Keep` in PowerShell) when you want to poke at the data after a failure.

Prerequisites are Node 24 or newer and Docker Desktop. The `--legacy-peer-deps` flag is needed because `@adonisjs/mail@10` declares a peer on a future Adonis version that npm refuses to resolve otherwise.

## Five minute manual bring up

If you'd rather drive the app yourself instead of letting the suite do it:

```bash
cp .env.example .env
docker compose up -d
npm install --legacy-peer-deps
node ace backoffice:setup

# Two terminals:
npm run dev                     # http server on 3333
node ace queue:work             # worker that materialises tenant schemas
```

Now provision a tenant and write into its private schema:

```bash
TENANT_ID=$(curl -s -X POST http://localhost:3333/demo/tenants \
  -H 'content-type: application/json' \
  -d '{"name":"Acme","email":"demo@acme.test","plan":"pro","tier":"premium"}' \
  | jq -r .tenantId)

# Wait a beat for the InstallTenant job to flip status to active
sleep 2

node ace tenant:migrate --tenant=$TENANT_ID

curl -s -X POST http://localhost:3333/demo/notes \
  -H "x-tenant-id: $TENANT_ID" \
  -H 'content-type: application/json' \
  -d '{"title":"hello","body":"first note"}' | jq
```

Every section below is a copy paste recipe for one feature. Same shape, different curl.

## Environment

| Variable | Default | What it does |
|---|---|---|
| `PORT`, `HOST` | `3333`, `127.0.0.1` | HTTP binding |
| `APP_KEY` | required | 32+ char secret for signing and AES GCM encryption |
| `TENANT_HEADER_KEY` | `x-tenant-id` | Header that carries the tenant UUID |
| `APP_DOMAIN` | `localhost` | Used by the subdomain resolver |
| `DB_*` | matches docker compose | `app` / `app` / `lasagna_demo` on port `55432` |
| `REDIS_*`, `QUEUE_REDIS_*`, `CACHE_REDIS_*` | localhost:56379, dbs 0 / 1 / 2 | Three logical Redis databases, one container |
| `BACKUP_STORAGE_PATH` | `./storage/backups` | Where `pg_dump` writes |
| `BACKUP_S3_*` | disabled | Set `BACKUP_S3_ENABLED=true` to mirror to S3 |
| `DEMO_ADMIN_TOKEN` | required | Sent as `x-admin-token` to gate the admin API and `/metrics` |
| `MAILCATCHER_HOST`, `MAILCATCHER_PORT` | `127.0.0.1`, `1025` | SMTP target. Web UI lives on port 1080 |
| `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME` | `demo@example.test`, `Demo Multitenancy` | Default From header when a tenant has no branding row |

The included `.env.example` is preconfigured for the docker compose stack, so you can copy it untouched.

## The feature tour

Each subsection points at the source file that demonstrates the feature, then gives you a curl recipe.

### 1. Schema isolation

Each tenant gets its own `tenant_<uuid>` Postgres schema. Switching the header switches the dataset, no shared `tenant_id` columns, no row level security to maintain.

[app/controllers/demo/notes_controller.ts](app/controllers/demo/notes_controller.ts) and [database/migrations/tenant/0001_create_notes_table.ts](database/migrations/tenant/0001_create_notes_table.ts).

```bash
curl -H "x-tenant-id: $TENANT_A" http://localhost:3333/demo/notes
curl -H "x-tenant-id: $TENANT_B" http://localhost:3333/demo/notes
# Two separate row sets. Always.

curl -H "x-tenant-id: $TENANT_A" http://localhost:3333/demo/connection
# {"tenantId":"...","connectionName":"tenant_..."}
```

### 2. Resolution strategies (header, subdomain, path)

The demo runs `header` for clarity. Flip `resolverStrategy` in [config/multitenancy.ts](config/multitenancy.ts) to try the others. The [tests/e2e/resolution_strategies.spec.ts](tests/e2e/resolution_strategies.spec.ts) file exercises all three at the resolver primitive level.

```bash
# Header (default)
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/connection

# Subdomain — set resolverStrategy: 'subdomain' and APP_DOMAIN
curl -H "host: $TENANT_ID.localhost" http://localhost:3333/demo/connection

# Path — set resolverStrategy: 'path'
curl http://localhost:3333/$TENANT_ID/demo/connection
```

### 3. Circuit breaker

Every tenant DB call is wrapped by an Opossum breaker. State is cached per tenant. Default `volumeThreshold` is 10, so you need ten consecutive failures before the breaker trips, which keeps CI tolerant of a flaky seed run.

[app/controllers/demo/circuit_controller.ts](app/controllers/demo/circuit_controller.ts).

```bash
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/circuit
# {"tenantId":"...","metrics":{"state":"CLOSED","failures":0,"successes":42,...}}
```

### 4. Lifecycle hooks plus all 11 events

The `beforeProvision` hook in [config/multitenancy.ts](config/multitenancy.ts) rejects emails that don't end in `.test`. That same hook can run schema bootstrap, seed initial data, or wire OAuth tenants. It runs inside the `InstallTenant` job, which means a thrown hook flips the tenant to `failed` after the create endpoint has already returned `202`.

The 11 events (`TenantCreated`, `TenantActivated`, `TenantSuspended`, `TenantProvisioned`, `TenantMigrated`, `TenantBackedUp`, `TenantRestored`, `TenantCloned`, `TenantUpdated`, `TenantDeleted`, `TenantQuotaExceeded`) all have listeners in [app/listeners/audit_listener.ts](app/listeners/audit_listener.ts) that write rows into `backoffice.tenant_audit_logs`. The listener is registered from [app/providers/app_provider.ts](app/providers/app_provider.ts) on the `ready()` hook (the emitter is not available during `boot()`). Read the rows back through [app/controllers/demo/audit_controller.ts](app/controllers/demo/audit_controller.ts).

```bash
# Hook reject path: shape passes the validator (the .test rule is a business
# rule, not a shape rule), creation is accepted, then InstallTenant throws
# inside the job and the tenant flips to status=failed.
curl -X POST http://localhost:3333/demo/tenants \
  -H 'content-type: application/json' \
  -d '{"name":"Bad","email":"bad@example.com"}'
# 202 → poll GET /demo/tenants/<id> and watch status flip to "failed"

# Validator reject path (missing email): VineJS surfaces validation as 422
curl -X POST http://localhost:3333/demo/tenants \
  -H 'content-type: application/json' -d '{"name":"x"}'
# 422 with structured error body

# Read the audit trail
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/audit | jq
```

### 5. Contextual logging

`TenantGuardMiddleware` wraps the rest of the request in `TenantLogContext.run({ tenantId })` using AsyncLocalStorage. Inside the request, `tenantLogger()` returns a child pino logger bound to the current tenant id. You don't have to thread the id through anything.

```bash
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/notes
# In your dev terminal, pino prints:
#   [12:34:56] INFO (test): listed notes
#       tenantId: "abc-123-..."
#       count: 2
```

[tests/e2e/contextual_logging.spec.ts](tests/e2e/contextual_logging.spec.ts) verifies the binding both at the AsyncLocalStorage layer and across concurrent requests, so a fix in one place can't accidentally leak across tenants.

### 6. Health probes and Prometheus

One call mounts `/livez`, `/readyz`, `/healthz`, and `/metrics`. Same shape as a real production deployment. The probes stay public for orchestrators; `/metrics` is fail-closed (it exposes per-tenant labels and tenant counts), so the demo gates it with the same `x-admin-token` as the admin API.

```bash
curl http://localhost:3333/livez       # process is alive
curl http://localhost:3333/readyz      # DB + Redis + circuit checks
curl http://localhost:3333/healthz     # the full diagnostic JSON
curl http://localhost:3333/metrics \
  -H "x-admin-token:$(grep DEMO_ADMIN_TOKEN .env | cut -d= -f2)"  # Prometheus 0.0.4 text exposition
```

### 7. The doctor

`tenant:doctor` runs eight built in checks (failed tenants, stalled provisioning, schema drift, migration state, circuit breakers, queue stuck, backup recency) plus the demo's `demo_marker_check`. Run it as a CLI table, JSON for CI, scoped to a single tenant, in watch mode for a live TUI, or with `--fix` to auto repair what it can (resetting open circuits is the canonical example).

```bash
node ace tenant:doctor                                 # human readable table
node ace tenant:doctor --json                          # CI friendly
node ace tenant:doctor --check=schema_drift            # one check
node ace tenant:doctor --tenant=$TENANT_ID             # scope to a tenant
node ace tenant:doctor --fix                           # auto repair
node ace tenant:doctor --watch --interval=2000         # TUI

# Same diagnostic over HTTP, gate behind admin auth in prod
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/doctor | jq
```

### 8. Plans and quotas

Plans live in [config/multitenancy.ts](config/multitenancy.ts). The demo defines `free` (50 calls per day) and `pro` (10000). The `enforceQuota('apiCallsPerDay')` middleware is wired on `POST /demo/notes` and returns 429 once the limit is hit, dispatching `TenantQuotaExceeded` so the audit log records the breach.

```bash
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/quota/state | jq

# Manual bump
curl -X POST -H "x-tenant-id: $TENANT_ID" -H 'content-type: application/json' \
  http://localhost:3333/demo/quota/track -d '{"quota":"apiCallsPerDay","amount":5}'

# Trip the limit on a free plan tenant. The 51st call returns 429.
for i in $(seq 1 60); do
  curl -s -o /dev/null -w "%{http_code} " -X POST \
    -H "x-tenant-id: $FREE_TENANT_ID" -H 'content-type: application/json' \
    http://localhost:3333/demo/notes -d '{"title":"spam"}'
done
# 201 201 201 ... 429 429 429
```

### 9. Backups, restore, import, clone

Two retention tiers (`standard` 24h, keep 7; `premium` 6h, keep 30). Pick the tier per tenant via the typed metadata. The `tenant:backups:run` command is idempotent and tier aware, so wiring it to hourly cron is safe.

```bash
node ace tenant:backup --tenant=$TENANT_ID
node ace tenant:backups:run --dry-run
node ace tenant:backups:run                               # wire to hourly cron
node ace tenant:backups:run --force --tenant=$TENANT_ID

node ace tenant:restore --tenant=$TENANT_ID --file=tenant_<id>_<ts>.dump
node ace tenant:import --tenant=$TENANT_ID --file=./dump.sql --schema-replace=public --force
node ace tenant:clone --source=$SRC_ID --name="Clone" --email="clone@e2e.test"
```

The whole chain lives in [tests/e2e/backups_real.spec.ts](tests/e2e/backups_real.spec.ts). The seed dump used by the import test is at [tests/fixtures/demo-tenant.sql](tests/fixtures/demo-tenant.sql) and includes a `widgets` table that isn't in the migrations, so its presence after import is unambiguous proof that the dump was applied.

### 10. Read replicas

Three strategies: `sticky` (the same tenant always lands on the same replica via SHA1 hashing), `round-robin` (global cursor), and `random`. The demo uses `sticky` and points the "replica" back at the primary host because the docker stack is single Postgres. In production each entry in `tenantReadReplicas.hosts` is a separate read endpoint.

[app/models/backoffice/tenant.ts → getReadConnection()](app/models/backoffice/tenant.ts).

```bash
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/notes/read | jq
# {"readFrom":"tenant_<uuid>_read_0","isReplica":true,"notes":[...]}
```

[tests/e2e/replicas_strategies.spec.ts](tests/e2e/replicas_strategies.spec.ts) flips the strategy at runtime via `setConfig` and asserts that round robin and random both hit every replica over enough iterations.

### 11. Soft delete and purge

Recycle bin pattern. Soft delete preserves the schema for `softDelete.retentionDays` (default 30), then `tenant:purge-expired` drops it for real. Hard delete via the destroy endpoint runs the `UninstallTenant` job and drops the schema immediately.

```bash
# Soft delete: row marked, schema preserved
curl -X DELETE "http://localhost:3333/demo/tenants/$TENANT_ID?keepSchema=true"

# Hard delete: schema dropped via the queue job
curl -X DELETE "http://localhost:3333/demo/tenants/$TENANT_ID"

# Purge soft deleted tenants past the retention window
node ace tenant:purge-expired --dry-run
node ace tenant:purge-expired --retention-days=0 --force      # purge everything now
```

### 12. Typed metadata

`request.tenant<DemoMeta>()` is fully typed across the controllers. No `as any`, no runtime guards. See [app/models/backoffice/tenant.ts → DemoMeta](app/models/backoffice/tenant.ts) and any controller under [app/controllers/demo/](app/controllers/demo/) for the call site.

### 13. The admin REST API

Nine endpoints mounted at `/admin` by `multitenancyAdminRoutes()`. The demo gates them behind a header based fake auth; swap [app/middleware/demo_admin_auth_middleware.ts](app/middleware/demo_admin_auth_middleware.ts) for whatever your real admin auth looks like.

```bash
ADMIN="-H x-admin-token:$(grep DEMO_ADMIN_TOKEN .env | cut -d= -f2)"

curl $ADMIN http://localhost:3333/admin/tenants                              # list (filter with ?status= and ?includeDeleted=)
curl $ADMIN http://localhost:3333/admin/tenants/$TENANT_ID                   # show
curl -X POST $ADMIN http://localhost:3333/admin/tenants/$TENANT_ID/suspend
curl -X POST $ADMIN http://localhost:3333/admin/tenants/$TENANT_ID/activate
curl -X POST $ADMIN http://localhost:3333/admin/tenants/$TENANT_ID/destroy -d '{"keepSchema":true}'
curl -X POST $ADMIN http://localhost:3333/admin/tenants/$TENANT_ID/restore
curl $ADMIN http://localhost:3333/admin/tenants/$TENANT_ID/queue/stats        # BullMQ counts
curl $ADMIN http://localhost:3333/admin/health/report                         # full DoctorService report, 503 on errors
```

Every endpoint plus the auth gate is verified in [tests/e2e/admin_full.spec.ts](tests/e2e/admin_full.spec.ts).

### 14. Webhooks with HMAC signing

Tenants subscribe to events with a URL, a list of event names, and an optional secret. The `WebhookService` POSTs the JSON payload, signs it with HMAC SHA256 in the `x-webhook-signature` header when a secret is set, and retries with exponential backoff (10s, 60s, 5m, 30m, 2h with 20% jitter) for up to five attempts.

```bash
# Subscribe
curl -X POST -H "x-tenant-id: $TENANT_ID" -H 'content-type: application/json' \
  http://localhost:3333/demo/webhooks \
  -d '{"url":"https://webhook.site/<your-uuid>","events":["note.created"],"secret":"shhh"}'

# Fire a test event
curl -X POST -H "x-tenant-id: $TENANT_ID" -H 'content-type: application/json' \
  http://localhost:3333/demo/webhooks/fire \
  -d '{"event":"note.created","payload":{"foo":"bar"}}'

# Drain the retry queue (cron in prod)
node ace tenant:webhooks:retry
```

[tests/e2e/webhooks_delivery.spec.ts](tests/e2e/webhooks_delivery.spec.ts) spins up an in process HTTP listener, fires the event, and asserts the listener received a POST with a matching HMAC. It also checks the failure path against a closed port and confirms `tenant:webhooks:retry` exits cleanly.

### 15. Email through MailCatcher

Activating a tenant fires `TenantActivated`. The listener at [app/listeners/tenant_welcome_listener.ts](app/listeners/tenant_welcome_listener.ts) (registered from `AppProvider.ready()`) loads the tenant's branding row, builds [app/mailers/tenant_welcome_mail.ts](app/mailers/tenant_welcome_mail.ts), and ships it through `mail.send`. MailCatcher captures the SMTP traffic, the web UI is at [http://localhost:1080](http://localhost:1080).

```bash
# Provision a branded tenant
TENANT_ID=$(curl -s -X POST http://localhost:3333/demo/tenants \
  -H 'content-type: application/json' \
  -d '{"name":"BrandCo","email":"hello@brandco.test","plan":"pro","tier":"premium"}' \
  | jq -r .tenantId)

# Apply branding
curl -X PUT -H "x-tenant-id: $TENANT_ID" -H 'content-type: application/json' \
  http://localhost:3333/demo/branding \
  -d '{"fromName":"BrandCo","fromEmail":"no-reply@brandco.test","primaryColor":"#FF00FF"}'

# Open MailCatcher
open http://localhost:1080
```

[tests/e2e/mail.spec.ts](tests/e2e/mail.spec.ts) verifies the email reaches MailCatcher, that the body carries the right branding, that two tenants never see each other's strings, and that a queue worker subprocess delivers the queued mail. It also flips the SMTP port to a closed value and asserts the host process keeps serving requests when the mailer fails.

### 16. Satellites: feature flags, branding, SSO

Three satellite tables, three services, three demo controllers. Every operation is tenant scoped end to end.

```bash
# Feature flags
curl -X POST -H "x-tenant-id: $TENANT_ID" -H 'content-type: application/json' \
  http://localhost:3333/demo/feature-flags \
  -d '{"flag":"beta_widgets","enabled":true,"config":{"rollout":50}}'
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/feature-flags
curl -X DELETE -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/feature-flags/beta_widgets

# Branding
curl -X PUT -H "x-tenant-id: $TENANT_ID" -H 'content-type: application/json' \
  http://localhost:3333/demo/branding \
  -d '{"fromName":"Acme","fromEmail":"no-reply@acme.test","primaryColor":"#FF00FF"}'
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/branding

# SSO (the response never echoes clientSecret in plaintext)
curl -X PUT -H "x-tenant-id: $TENANT_ID" -H 'content-type: application/json' \
  http://localhost:3333/demo/sso \
  -d '{"clientId":"abc","clientSecret":"shhh","issuerUrl":"https://acme.okta.com","redirectUri":"https://acme.test/cb","scopes":["openid","email"]}'
curl -H "x-tenant-id: $TENANT_ID" http://localhost:3333/demo/sso
```

HTTP coverage lives in [tests/e2e/satellites.spec.ts](tests/e2e/satellites.spec.ts). Service level coverage with deeper assertions (cache invalidation, tenant isolation, default fallbacks) lives at [packages/core/tests/integration/services/](../../packages/core/tests/integration/services/).

### 17. Testing helpers

`buildTestTenant`, `MockTenantRepository`, and `setRequestTenant` are exported from `@adonisjs-lasagna/saas-tenancy/testing`. They let you write fast unit tests for tenant aware code without a real database. [tests/e2e/smoke.spec.ts](tests/e2e/smoke.spec.ts) is a demo of each.

```bash
npm run test                  # smoke and unit assertions, no docker required
```

## The full ace cheat sheet

```bash
node ace list                                # every command the package adds
node ace tenant:list --all                   # include soft deleted
node ace tenant:repl <uuid>                  # REPL with tenant + db + audit + ... preloaded
node ace tenant:seed --tenant=<uuid>         # run database/seeders/notes_seeder.ts
node ace tenant:seed                         # seed every active tenant
node ace tenant:queue:stats                  # BullMQ counts per tenant queue
node ace tenant:metrics:flush                # drain redis counters into the metrics table
node ace tenant:migrate --tenant=<uuid>      # run pending tenant migrations
node ace tenant:migrate:rollback --tenant=<uuid>
```

## A sane cron baseline

```
* * * * *   node ace tenant:webhooks:retry
0 * * * *   node ace tenant:backups:run
0 1 * * *   node ace tenant:metrics:flush
0 3 * * *   node ace tenant:purge-expired --force
*/5 * * * * node ace tenant:doctor --json | your-alerting-pipeline
```

## Troubleshooting

**`tenant:create` always rejected with "Demo enforces *.test emails only"**
The `beforeProvision` hook in [config/multitenancy.ts](config/multitenancy.ts) is doing exactly what it says. Use any address ending in `.test`, or rip the hook out.

**`InstallTenant` job never runs**
You need `node ace queue:work` in a separate terminal. The create endpoint dispatches a job and returns immediately; without a worker, status stays at `provisioning` forever. The e2e suite gets around this with an `installInline` helper.

**`tenant:backup` fails with `ENOENT: pg_dump`**
PostgreSQL client tools must be on PATH. Mac: `brew install libpq && brew link --force libpq`. Debian or Ubuntu: `apt install postgresql-client`. The e2e backup tests skip themselves with a clear message when the binaries aren't there, so this only blocks the CLI.

**`tenant:import` fails with `ENOENT: psql`**
Same cause. The importer shells out to `psql` for `COPY FROM stdin` blocks. INSERTs only dumps don't need it.

**Read replica routes always say `isReplica: false`**
Either `tenantReadReplicas` is missing from your config, or your tenant model doesn't override `getReadConnection()`. Check both. The demo wires both.

**`@adonisjs/mail` not found at boot**
Run `npm install --legacy-peer-deps`. The dep is real, npm just refuses to resolve the peer range without the flag because Adonis core 7 is still pre release.

**MailCatcher never receives the welcome email**
Confirm the container is up (`docker compose ps mailcatcher`). The mail listener uses dynamic imports inside try / catch, so a missing dep or unreachable host is swallowed silently to keep the rest of the suite green. The mail tests detect this and skip with a message, which is what you want in CI but inconvenient when you're staring at MailCatcher waiting for a message.

## Why this folder exists

A package README that doesn't ship a runnable example is half a thing. Every claim in the root README maps to a curl recipe here, a controller here, and a test here. If a feature ever stops being demoable, the suite turns red before anyone notices in production. That guarantee is worth the maintenance cost.

If you cloned this and something feels off, open an issue on the [main repo](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/issues). I read every one.

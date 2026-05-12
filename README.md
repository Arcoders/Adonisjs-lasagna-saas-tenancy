# @adonisjs-lasagna/saas-tenancy

```
 ██╗      █████╗ ███████╗ █████╗  ██████╗ ███╗   ██╗ █████╗
 ██║     ██╔══██╗██╔════╝██╔══██╗██╔════╝ ████╗  ██║██╔══██╗
 ██║     ███████║███████╗███████║██║  ███╗██╔██╗ ██║███████║
 ██║     ██╔══██║╚════██║██╔══██║██║   ██║██║╚██╗██║██╔══██║
 ███████╗██║  ██║███████║██║  ██║╚██████╔╝██║ ╚████║██║  ██║
 ╚══════╝╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═╝  ╚═══╝╚═╝  ╚═╝
```

SaaS multi-tenancy for AdonisJS 7. Every tenant lives in its own
isolated PostgreSQL schema, with a real package behind it: connection
routing, circuit breaking, queues, contextual logging, plans and quotas,
scheduled backups with retention, read-replica routing, soft delete, and
a satellite suite covering audit logs, webhooks, branding, SSO, feature
flags, metrics, and Stripe billing.

[![npm](https://img.shields.io/npm/v/@adonisjs-lasagna/saas-tenancy?color=C26A4B&label=npm)](https://www.npmjs.com/package/@adonisjs-lasagna/saas-tenancy)
[![Node.js](https://img.shields.io/badge/Node.js-%E2%89%A524-green)](https://nodejs.org)
[![AdonisJS](https://img.shields.io/badge/AdonisJS-7-5a45ff)](https://adonisjs.com)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-%E2%89%A514-336791)](https://www.postgresql.org)
[![Redis](https://img.shields.io/badge/Redis-%E2%89%A56-DC382D)](https://redis.io)
[![Tests](https://img.shields.io/badge/tests-404%20unit%20%2B%20105%20integration%20%2B%20111%20e2e-brightgreen)](./tests)
[![Docs](https://img.shields.io/badge/docs-published-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/)
[![License](https://img.shields.io/badge/License-MIT-blue)](./LICENSE)

📖 **[Full documentation →](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/)** · [Quickstart](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/quickstart) · [Why Lasagna](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/why) · [Comparison vs stancl](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/comparison) · [Release notes](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/release-notes)

I built this because the AdonisJS ecosystem deserved a proper multi
tenancy foundation, and because every SaaS I touched eventually outgrew
the `tenant_id` column. If you've ever exported one customer's data
with a giant `WHERE tenant_id = ?` JOIN across forty tables and prayed
nothing leaked, you already know the problem this solves.

If you'd rather see it run than read about it, jump to
[examples/api/](examples/api/). It's a real AdonisJS 7 app that
exercises every feature, and one `npm run test:e2e` brings up the stack
and runs 111 tests against it.

🔒 **Audited against real production failure modes** — cross-tenant isolation under concurrency, quota atomicity, SSO replay, audit immutability, header-vs-domain hijack, and more. [See what we verified →](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/why#hardened-against-the-failures-that-bite-you-in-production)

## Highlights

| Feature | What it gives you |
|---|---|
| **Schema isolation** | Each tenant gets its own `tenant_<uuid>` PostgreSQL schema, provisioned and routed automatically. |
| **Circuit breaker** | Opossum wraps every tenant DB call. One bad schema can't take down the others. |
| **Lifecycle hooks + 23 typed events** | Declarative `before` / `after` hooks wired into commands and jobs. 13 tenant-lifecycle events + 10 billing events. |
| **Contextual logging** | `tenantId` rides along through HTTP and queue jobs via `AsyncLocalStorage`. |
| **`tenant:doctor`** | Ten built-in checks, `--fix` for auto-recovery, `--json` for CI, `--watch` for a live TUI. |
| **Plans and quotas** | Declarative plans, rolling counters, snapshot usage, an `enforceQuota()` middleware that returns 429 and emits `TenantQuotaExceeded`. |
| **Scheduled backups + retention** | Tier-based intervals and `keepLast`, S3 mirror with purge awareness, idempotent cron command. |
| **Health probes + Prometheus** | `/livez`, `/readyz`, `/healthz`, `/metrics`. No `prom-client` peer dep. |
| **Read replica routing** | Round-robin, random, or sticky-by-tenant-id with stable connection naming. |
| **REST admin API** | 36 endpoints + OpenAPI 3.1 spec + Swagger UI. You bring the auth middleware. |
| **Soft delete TTL** | Recycle bin pattern. `--keep-schema` on destroy, `tenant:purge-expired` on a cron. |
| **Nine satellites** | Audit logs (append-only at the SQL level), webhooks (HMAC-signed + retries + verifier helper), quotas, feature flags, branding, SSO/OIDC, metrics, impersonation, and Stripe billing (idempotent webhook + dunning + metered + checkout/portal + lifecycle). All optional. |

Two questions to ask before adopting:

1. **Do you actually need true tenant isolation, or is a `tenant_id`
   column enough?** If you want both at-rest separation and per-tenant
   migrations, this is for you. If you don't, save yourself the
   operational complexity.
2. **Are you on PostgreSQL?** Schemas are a Postgres-native concept.
   MySQL and MariaDB users should look elsewhere.

## Install

```bash
npm install @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/saas-tenancy
```

The configure command registers the provider, publishes
`config/multitenancy.ts`, scaffolds `app/models/backoffice/tenant.ts`,
and (selectively) publishes satellite migration stubs.

```bash
# Selective satellites
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks

# CI (no prompt)
node ace configure @adonisjs-lasagna/saas-tenancy --no-interaction --with=audit,branding
```

The full [5-minute quickstart](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/quickstart)
covers DB connections, the tenant repository binding, middleware
registration, and creating your first tenant.

## Documentation

The complete documentation lives at
**[arcoders.github.io/Adonisjs-lasagna-saas-tenancy](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/)**.
Direct links:

- 🚀 [Quickstart](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/quickstart)
- 🚢 [Deployment guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/deployment) (Dockerfile, docker-compose, Helm chart)
- 🛡️ [Security guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/security) (what the package guarantees vs what the host owns)
- ⚖️  [Comparison vs `stancl/tenancy`](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/comparison)

## Reference app

[`examples/api/`](examples/api/) is a real AdonisJS 7 app that wires
every feature end-to-end:

```bash
cd examples/api
npm install
docker compose -f compose.test.yml up -d
npm run test:e2e
```

The 111-test e2e suite covers provisioning, schema isolation,
contextual logging across HTTP + queue, the doctor command, backups +
restore + clone, quotas → 429, lifecycle events, the admin REST API,
mail context propagation, replica routing, and the webhook delivery
state machine.

## Stack

- **Node.js 24+**, ESM-native (`module: NodeNext`)
- **AdonisJS 7** with `@adonisjs/lucid`, `@adonisjs/queue`, `@adonisjs/redis`
- **PostgreSQL 14+** (the package does not target MySQL/MariaDB)
- Optional peers: `@adonisjs/drive`, `@adonisjs/mail`, `@adonisjs/session`,
  `@aws-sdk/client-s3`, `jose` (only when SSO is used), `better-sqlite3`
  (in-memory testing driver)

## Contributing

```bash
npm install --legacy-peer-deps
npm run typecheck
npm test
docker compose -f compose.test.yml up -d
npm run test:integration
npm run docs:dev      # live preview of the docs site
```

PRs welcome. Please add tests for any behavior change and run the
typecheck + unit suite before pushing. CI gates: typecheck, unit
tests, integration tests against real Postgres + Redis, e2e demo app
suite, knip (informational), and `npm audit --audit-level=high`.

## License

MIT — see [LICENSE](./LICENSE).

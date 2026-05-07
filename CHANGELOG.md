# Changelog

All notable changes to `@adonisjs-lasagna/saas-tenancy` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [0.1.0] — 2026-05-07

Initial release of `@adonisjs-lasagna/saas-tenancy`.

This package continues the work previously published as
`@adonisjs-lasagna/multitenancy` v2.x. The rename reflects the
positioning of the package as the SaaS-tenancy foundation for
AdonisJS 7. The codebase is the same hardened core: pluggable
isolation drivers (schema-pg, database-pg, rowscope-pg, sqlite-memory),
13 typed lifecycle events, eight satellite features, contextual
logging, scheduled backups, read-replica routing, the `tenant:doctor`
diagnostic command, and an admin REST API.

### Highlights

- **Schema isolation** — every tenant gets its own `tenant_<uuid>`
  PostgreSQL schema, provisioned and routed automatically.
- **Pluggable isolation** — schema-per-tenant, database-per-tenant,
  shared-with-row-scope, or in-memory SQLite for tests.
- **Lifecycle hooks + 13 typed events** — declarative `before` /
  `after` hooks wired into commands and jobs.
- **Contextual logging** — `tenantId` rides through HTTP and queue
  jobs via `AsyncLocalStorage`.
- **`tenant:doctor`** — ten built-in checks, `--fix` for auto-recovery,
  `--json` for CI, `--watch` for a live TUI.
- **Plans & quotas** — declarative plans, atomic rolling counters,
  snapshot usage, `enforceQuota()` middleware that returns 429.
- **Scheduled backups + retention** — tier-based intervals, S3 mirror
  with purge awareness.
- **Health probes + Prometheus** — `/livez`, `/readyz`, `/healthz`,
  `/metrics`. No `prom-client` peer dep.
- **Read replica routing** — round-robin, random, or sticky-by-tenant-id.
- **REST admin API** — 36 endpoints + OpenAPI 3.1 spec + Swagger UI.
- **Soft delete TTL** — `--keep-schema` on destroy,
  `tenant:purge-expired` on a cron.
- **Eight satellites** — audit logs (append-only at SQL level),
  webhooks (HMAC-signed + retries), quotas, feature flags, branding,
  SSO/OIDC, metrics, impersonation. All optional.

### History

Pre-rename history (v1.x and v2.0.0-beta.x of
`@adonisjs-lasagna/multitenancy`) lives at the prior repository:
[github.com/Arcoders/Adonisjs-Lasagna-Multitenancy](https://github.com/Arcoders/Adonisjs-Lasagna-Multitenancy).

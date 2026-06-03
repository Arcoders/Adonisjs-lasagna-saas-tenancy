---
title: Security
description: What Lasagna SaaS Tenancy guarantees about isolation, audit, and abuse — and what the host application is still responsible for.
---

# Security

A multi-tenant package is only as strong as its weakest dependency on
the host. This page draws the line: what the package enforces at the
code/SQL level, what the host application still owns, and which
production failure modes we audit against in the integration suite.

## What the package guarantees

These properties hold regardless of how the host application is
written. If you find a way to break one, that's a security bug — see
[Reporting vulnerabilities](#reporting-vulnerabilities).

| Guarantee | How it's enforced |
|---|---|
| **No DDL injection via `tenant.id`** | `assertSafeIdentifier()` rejects anything that could escape a quoted PG identifier (`"`, `;`, whitespace, shell metacharacters, length > 63) at every driver entry that interpolates the id into DDL. |
| **No `shell: true` in `spawn(...)`** | `pg_dump`, `pg_restore`, and `psql` are spawned without a shell on every platform. cmd.exe metacharacter interpretation is not in the surface. |
| **No silent cross-tenant fetch** | A `withTenantScope`-backed model queried outside both `tenancy.run()` and `unscoped()` throws `MissingTenantScopeException` instead of returning every tenant's rows. Strict mode is the default. Opt-out is a deliberate `isolation.rowScopeMode: 'allowGlobal'`. |
| **No silent cross-tenant write** | Bulk `Model.query().delete()` / `.update()` on a scoped model are intercepted by the `before('fetch')` hook (Lucid fires it for query-builder paths). Cross-tenant wipes are not reachable through the ORM. |
| **Tenant routing only on valid UUID v4** | `TenantAdapter.modelConstructorClient()` validates the resolved tenant id before picking the Lucid connection. A malformed id falls through to a clean error rather than colliding with another tenant's pool. |
| **Atomic quota enforcement** | `QuotaService.consume()` issues a single `EVAL` (Lua) round-trip to Redis: `GET`, compare against the limit, `INCRBY`+`EXPIRE` only when the new total fits. No over-grant under burst. |
| **Atomic SSO state** | `SsoService` reads the OAuth/OIDC `state` parameter via Redis `GETDEL` so a replayed callback can never re-validate. CSRF + replay closed in one round-trip. |
| **Append-only audit at SQL level** | The `tenant_audit_logs` migration installs three triggers — `BEFORE UPDATE`, `BEFORE DELETE`, `BEFORE TRUNCATE` — that all `RAISE EXCEPTION`. Even a compromised app role cannot rewrite or erase audit rows; only a privileged retention role with the trigger temporarily disabled can purge by date. |
| **Strict domain mode rejects header/domain hijack** | `CustomDomainMiddleware({ strict: true })` rejects requests where the resolved tenant id from the header doesn't match the domain. Throws `TenantHeaderDomainMismatchException` (HTTP 400) before any handler runs. |
| **Bounded connection pool** | The fixture `Tenant` model demonstrates an LRU cap on tenant connections (50 by default). One tenant flooding requests cannot starve every other tenant's pool. Hosts should keep this LRU pattern in their `Tenant` implementation. |
| **No singleton retention across boots** | `provider.shutdown()` invalidates the module-level caches in `tenancy.ts` and `active_driver.ts`. Test runners and hot-reload paths can't hold references to dead containers, which is also how we keep the integration suite hermetic. |

## What the host owns

These are deliberate non-goals of the package. They live in your
application because they depend on operational context the package
cannot infer.

| Responsibility | Why it's yours |
|---|---|
| **Auth on the admin REST API** | The 36 admin endpoints carry whatever middleware you wire them through. Lasagna ships zero default auth — bring `auth.use('admin').authenticate` or your own. `multitenancyAdminRoutes()` is **fail-closed**: it throws at startup unless you pass `middleware`, or pass `middleware: false` to deliberately mount it public behind a trusted network boundary. It also accepts a `resolveAdminActor` callback that the impersonation endpoints require *before* they will issue tokens, so you cannot accidentally forge audit trails by leaving the resolver unset. |
| **TLS termination for custom domains** | The package routes by `Host` header but does not provision certificates. The [custom-domain HTTPS cookbook](/docs/cookbook/custom-domain-https) walks through ACME via Caddy / Cert-Manager. |
| **Database role permissions** | The package assumes the application connects with a role that has `CREATE`/`DROP` on the tenant database (for `schema-pg` / `database-pg` drivers). It does **not** assume superuser. Run the audit-log retention job under a separate role that the application cannot escalate to. |
| **Secret rotation** | Encryption keys (`utils/crypto.ts`), OIDC client secrets, NPM publish tokens, S3 credentials. The package consumes these from config and environment; it does not rotate them. |
| **Backup encryption at rest** | `BackupService` writes `pg_dump --format=custom --compress=9` archives. They are not encrypted by the package — encrypt the storage volume or the S3 bucket. The mirror to S3 uses whatever bucket policy the bucket has. |
| **Audit log retention** | The append-only triggers prevent ad-hoc deletes. Schedule a retention job under a privileged role that disables the trigger, prunes by `created_at`, and re-enables it. See the [Audit logs satellite](/docs/satellites/audit#retention). |
| **Tenant model field-level security** | If your `Tenant` model has columns that should never serialize (Stripe customer ids, internal flags), add `@column({ serializeAs: null })` to them. The admin API serializes the whole model verbatim by default. |
| **Rate limiter availability** | If Redis is unreachable when `RateLimitMiddleware` runs, the package raises `RateLimitUnavailableException`. The host decides whether that maps to fail-open (502) or fail-closed (429) — there is no global "ignore Redis" mode that would silently disable rate limiting. |

## Failure modes we audit against

The integration suite has dedicated specs for the failure modes that
historically trip multi-tenant systems. Each spec runs against real
PostgreSQL and Redis (no mocks) under contention.

| Failure mode | Test |
|---|---|
| Cross-tenant data leak under concurrent writes | [`tests/integration/isolation/cross_tenant_e2e.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/isolation/cross_tenant_e2e.spec.ts) — 5 tenants × 20 concurrent POST/GET, asserts zero cross-tenant rows. |
| Job-context leak under interleaved tenants | [`tests/integration/jobs/tenant_context.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/jobs/tenant_context.spec.ts) — 3 tenants × 30 randomly-shuffled jobs, asserts AsyncLocalStorage never bleeds. |
| Audit row tampering (UPDATE / DELETE / TRUNCATE) | [`tests/integration/satellites/audit_immutability.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/satellites/audit_immutability.spec.ts) — verifies all three triggers reject ORM and raw query attempts. |
| Quota over-grant under burst | [`tests/integration/services/quota_concurrency.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/services/quota_concurrency.spec.ts) — atomic Lua check survives N concurrent `consume()` calls at the limit. |
| SSO state CSRF / replay | [`tests/integration/services/sso_oidc_flow.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/services/sso_oidc_flow.spec.ts) — mock OIDC IdP over real HTTP; replay of `state` returns 401, never 200. |
| Header-vs-domain hijack | [`tests/integration/middleware/header_vs_domain_precedence.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/middleware/header_vs_domain_precedence.spec.ts) — strict mode rejects mismatched header/domain, header-only and domain-only modes behave as documented. |
| Cache namespace collision | [`tests/integration/services/cache_for.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/tests/integration/services/cache_for.spec.ts) — per-tenant BentoCache namespaces never share keys. |

## Hardening checklist for production

Before going live, work through this list — every item is a host
responsibility (the package gives you the primitives).

- [ ] Auth middleware wired in front of `multitenancyAdminRoutes(...)` and `resolveAdminActor` set.
- [ ] Database role used by the app does **not** have `SUPERUSER` or `BYPASSRLS`.
- [ ] A separate database role (or out-of-band script) handles audit-log retention with the trigger disabled in a controlled window.
- [ ] `multitenancy.config.isolation.rowScopeMode` left at the default unless you've audited every cross-tenant query.
- [ ] `CustomDomainMiddleware` registered with `strict: true` if you accept the tenant header *and* use custom domains.
- [ ] Backup storage volume / S3 bucket is encrypted at rest and lifecycle-managed.
- [ ] Rate-limit policy on `RateLimitUnavailableException` is decided and tested (fail-open vs fail-closed).
- [ ] OIDC `client_secret`, encryption keys, and S3 credentials live in a secrets manager, not `.env` checked into git.
- [ ] `tenant:doctor` runs on a cron in production (the [doctor command](/docs/commands#tenant-doctor)) and pages on `error`-level findings.
- [ ] Health probes wired (`/livez`, `/readyz`, `/healthz`, `/metrics`) — see [Health & metrics](/docs/health).

## Reporting vulnerabilities

Please **do not** open a public issue for security reports. Instead:

- Email the maintainer directly (see [`package.json`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/package.json) for current contact), or
- Open a private security advisory at
  [github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/security/advisories/new](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/security/advisories/new).

Include a minimal reproduction (PostgreSQL + Redis are fine), the
package version, and the threat model you're testing against (the
guarantee table above is a good reference). We will acknowledge within
72 hours and coordinate a fix + disclosure window.

## Related

- [Concepts](/docs/concepts) — connection routing, schema model, the boundary the guarantees sit on.
- [Audit logs](/docs/satellites/audit) — append-only enforcement details.
- [Quotas](/docs/satellites/quotas) — atomic enforcement details.
- [SSO](/docs/satellites/sso) — atomic state details.
- [Custom-domain HTTPS](/docs/cookbook/custom-domain-https) — TLS termination patterns.

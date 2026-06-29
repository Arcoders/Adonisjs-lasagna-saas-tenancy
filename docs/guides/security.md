---
title: Security
description: What Lasagna SaaS Tenancy guarantees about isolation, audit, and abuse, and what the host application is still responsible for.
---

# Security

A multi-tenant package is only as strong as its weakest dependency on
the host. This page draws the line: what the package enforces at the
code/SQL level, what the host application still owns, and which
production failure modes we audit against in the integration suite.

## What the package guarantees

These properties hold regardless of how the host application is
written. If you find a way to break one, that's a security bug. See
[Reporting vulnerabilities](#reporting-vulnerabilities).

| Guarantee | How it's enforced |
|---|---|
| **No DDL injection via `tenant.id`** | `assertSafeIdentifier()` rejects anything that could escape a quoted PG identifier (`"`, `;`, whitespace, shell metacharacters, length > 63) at every driver entry that interpolates the id into DDL. |
| **No `shell: true` in `spawn(...)`** | `pg_dump`, `pg_restore`, and `psql` are spawned without a shell on every platform. cmd.exe metacharacter interpretation is not in the surface. |
| **No silent cross-tenant fetch** | A `withTenantScope`-backed model queried outside both `tenancy.run()` and `unscoped()` throws `MissingTenantScopeException` instead of returning every tenant's rows. Strict mode is the default. Opt-out is a deliberate `isolation.rowScopeMode: 'allowGlobal'`. |
| **No silent cross-tenant write** | Bulk `Model.query().delete()` / `.update()` on a scoped model get the tenant predicate injected when the query builder is constructed (the mixin wraps the static `query()` factory; Lucid's `before('fetch')` hook only fires for selects). Cross-tenant wipes are not reachable through the ORM; proven against real Lucid + PostgreSQL for both delete and update. |
| **Tenant routing only on valid UUID v4** | `TenantAdapter.modelConstructorClient()` validates the resolved tenant id before picking the Lucid connection. A malformed id falls through to a clean error rather than colliding with another tenant's pool. |
| **Atomic quota enforcement** | `QuotaService.consume()` issues a single `EVAL` (Lua) round-trip to Redis: `GET`, compare against the limit, `INCRBY`+`EXPIRE` only when the new total fits. No over-grant under burst, as long as Redis is reachable. On a Redis outage the default policy (`resilience.redis.quota: 'fail-open'`) skips enforcement to stay available; choose `'fail-closed'` if correctness beats uptime. |
| **Atomic SSO state** | `SsoService` reads the OAuth/OIDC `state` parameter via Redis `GETDEL` so a replayed callback can never re-validate. CSRF + replay closed in one round-trip. |
| **Append-only audit at SQL level** | The `tenant_audit_logs` migration installs three triggers (`BEFORE UPDATE`, `BEFORE DELETE`, `BEFORE TRUNCATE`) that all `RAISE EXCEPTION`. Even a compromised app role cannot rewrite or erase audit rows; only a privileged retention role with the trigger temporarily disabled can purge by date. |
| **Strict domain mode rejects header/domain hijack (default)** | `CustomDomainMiddleware` is strict by default: it rejects requests where the tenant id from the header doesn't match the verified custom domain. Throws `TenantHeaderDomainMismatchException` (HTTP 400) before any handler runs. Opt out with `{ strict: false }` only for deliberate header-routing on managed domains. |
| **Bounded connection pool** | The package's connection LRU caps open tenant connections (`isolation.maxTenantConnections`, default 50) with an in-use grace window so in-flight requests are never severed, and an optional hard cap (`isolation.enforceConnectionCap`) that returns 503 instead of exceeding the budget. One tenant flooding requests cannot starve every other tenant's pool. |
| **No singleton retention across boots** | `provider.shutdown()` invalidates the module-level caches in `tenancy.ts` and `active_driver.ts`. Test runners and hot-reload paths can't hold references to dead containers, which is also how we keep the integration suite hermetic. |

## What the host owns

These are deliberate non-goals of the package. They live in your
application because they depend on operational context the package
cannot infer.

| Responsibility | Why it's yours |
|---|---|
| **Auth on the admin REST API** | The admin endpoints carry whatever middleware you wire them through. Lasagna ships zero default auth — bring `auth.use('admin').authenticate` or your own. `multitenancyAdminRoutes()` is **fail-closed**: it throws at startup unless you pass `middleware`, or pass `middleware: false` to deliberately mount it public behind a trusted network boundary. It also accepts a `resolveAdminActor` callback that the impersonation endpoints require *before* they will issue tokens, so you cannot accidentally forge audit trails by leaving the resolver unset. |
| **Tenant access authorization (membership)** | Tenant *resolution* is trust-the-input: with the `header` / `path` / `request-data` strategies the client supplies the tenant id (`x-tenant-id`, a URL segment, a field). The guard verifies the tenant **exists** and is **active**, but it does **not** check that the authenticated caller belongs to it, so without an app-layer check a user of tenant A can read tenant B by swapping the id (classic cross-tenant IDOR). Wire the package's `authorizeTenantAccess` hook (or your own middleware) to close it. This is a **membership check** (the first line of defense), *not* the place for full RBAC/roles/permissions, which stay in your policies. Return `false` (or throw) to deny with a 403 `TenantAccessForbiddenException`. With `@adonisjs/auth` session: `authorizeTenantAccess: (ctx, tenant) => ctx.auth?.user?.tenantId === tenant.id`. For users that belong to several tenants, look the pair up in your membership table: `authorizeTenantAccess: async (ctx, tenant) => ctx.auth?.user != null && (await Membership.query().where('user_id', ctx.auth.user.id).where('tenant_id', tenant.id).first()) != null`. The hook runs on the guard path; routes that skip the guard, jobs, and `tenancy.run()` scopes are not covered (same as the other guard checks). |
| **TLS termination for custom domains** | The package routes by `Host` header but does not provision certificates. The [custom-domain HTTPS cookbook](/guides/cookbook/custom-domain-https) walks through ACME via Caddy / Cert-Manager. |
| **Database role permissions** | The package assumes the application connects with a role that has `CREATE`/`DROP` on the tenant database (for `schema-pg` / `database-pg` drivers). It does **not** assume superuser. Run the audit-log retention job under a separate role that the application cannot escalate to. |
| **Secret rotation** | OIDC client secrets, NPM publish tokens, S3 credentials: the package consumes these from config and environment; it does not rotate them. The one rotation the package DOES support is `APP_KEY`: stored secrets (webhook signing secrets, SSO client secrets) are encrypted with a key derived from it, so rotating `APP_KEY` makes them all undecryptable. Treat an `APP_KEY` rotation as a secret-re-encryption event — set the new key, then run `OLD_APP_KEY=<previous> node ace tenant:secrets:reencrypt` (idempotent; `--dry-run` first). A secret that decrypts with neither key must be re-entered by the tenant. |
| **Backup encryption at rest** | `BackupService` writes `pg_dump --format=custom --compress=9` archives. They are not encrypted by the package; encrypt the storage volume or the S3 bucket. The mirror to S3 uses whatever bucket policy the bucket has. |
| **Audit log retention** | The append-only triggers prevent ad-hoc deletes. Schedule a retention job under a privileged role that disables the trigger, prunes by `created_at`, and re-enables it. See the [Audit logs satellite](/guides/satellites/audit#retention). |
| **Tenant model field-level security** | If your `Tenant` model has columns that should never serialize (Stripe customer ids, internal flags), add `@column({ serializeAs: null })` to them. The admin API serializes the whole model verbatim by default. |
| **Rate limiter availability** | If Redis is unreachable when `RateLimitMiddleware` runs, the default is fail-closed: the request gets a 503 (`RateLimitUnavailableException`), never a silent pass-through. Opt into fail-open per route (`failOpen: true`) or globally (`resilience.redis.rateLimit: 'fail-open'`) only if your threat model accepts unmetered traffic during a Redis outage. |

## Failure modes we audit against

The integration suite has dedicated specs for the failure modes that
historically trip multi-tenant systems. Each spec runs against real
PostgreSQL and Redis (no mocks) under contention.

| Failure mode | Test |
|---|---|
| Cross-tenant data leak under concurrent writes | [`tests/@guarantees/isolation/integration/isolation_cross_tenant_e2e.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/isolation/integration/isolation_cross_tenant_e2e.spec.ts) — 5 tenants × 20 concurrent POST/GET, asserts zero cross-tenant rows. |
| Job-context leak under interleaved tenants | [`tests/@guarantees/behavior/integration/behavior_tenant_context.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/behavior/integration/behavior_tenant_context.spec.ts) — 3 tenants × 30 randomly-shuffled jobs, asserts AsyncLocalStorage never bleeds. |
| Audit row tampering (UPDATE / DELETE / TRUNCATE) | [`tests/@guarantees/security/integration/security_audit_immutability.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/security/integration/security_audit_immutability.spec.ts) — verifies all three triggers reject ORM and raw query attempts. |
| Quota over-grant under burst | [`tests/@guarantees/behavior/integration/behavior_quota_concurrency.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/behavior/integration/behavior_quota_concurrency.spec.ts) — atomic Lua check survives N concurrent `consume()` calls at the limit. |
| SSO state CSRF / replay | [`packages/sso/tests/@guarantees/security/integration/security_sso_oidc_flow.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/packages/sso/tests/@guarantees/security/integration/security_sso_oidc_flow.spec.ts) — mock OIDC IdP over real HTTP; replay of `state` returns 401, never 200. |
| Header-vs-domain hijack | [`tests/@guarantees/behavior/integration/behavior_header_vs_domain_precedence.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/behavior/integration/behavior_header_vs_domain_precedence.spec.ts) — strict mode rejects mismatched header/domain, header-only and domain-only modes behave as documented. |
| Cache namespace collision | [`tests/@guarantees/behavior/integration/behavior_cache_for.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/behavior/integration/behavior_cache_for.spec.ts) — per-tenant BentoCache namespaces never share keys. |
| Cross-tenant IDOR via tenant-id swap | [`tests/@guarantees/security/integration/security_tenant_guard_authorize.spec.ts`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/tests/@guarantees/security/integration/security_tenant_guard_authorize.spec.ts): with `authorizeTenantAccess` wired, a caller whose principal belongs to tenant A gets 403 when resolving to tenant B. |

## Hardening checklist for production

Before going live, work through this list; every item is a host
responsibility (the package gives you the primitives).

- [ ] Auth middleware wired in front of `multitenancyAdminRoutes(...)` and `resolveAdminActor` set.
- [ ] `authorizeTenantAccess` set (or an equivalent app-layer guard) verifying the authenticated principal belongs to the resolved tenant; otherwise a swapped `x-tenant-id` is served against another tenant's schema. If membership is genuinely enforced elsewhere or out of scope, set `acknowledgeNoMembershipGate: true` to record that decision (it silences the cross-tenant-IDOR warning and the doctor / compliance check); leaving both unset with a client-controlled strategy (`header` / `path` / `request-data`) is flagged as a security risk.
- [ ] Database role used by the app does **not** have `SUPERUSER` or `BYPASSRLS`.
- [ ] Backoffice satellite tables (audit logs, feature flags, webhooks, branding, metrics, plans) live in one shared schema keyed by `tenant_id`. The package always filters those queries by tenant (enforced by the `backoffice_models_tenant_scoped` source guard; the few deliberate cross-tenant sweeps — the webhook retry drain, the audit export — are tagged `backoffice-scope-exempt`). For a database-level backstop on the shared schema, publish `--with=rls-backoffice` (`enable_rls_backoffice_isolation`) and wire the `app.backoffice_tenant_id` GUC on the per-tenant and sweep paths before enabling it.
- [ ] A separate database role (or out-of-band script) handles audit-log retention with the trigger disabled in a controlled window.
- [ ] `multitenancy.config.isolation.rowScopeMode` left at the default unless you've audited every cross-tenant query.
- [ ] `CustomDomainMiddleware` registered with `strict: true` if you accept the tenant header *and* use custom domains.
- [ ] If you resolve tenants by host (`subdomain` / `domain-or-subdomain`), set `resolver.expectedHostSuffix` to your tenant host suffix(es). A host strategy without it **fails boot in production**: the tenant is taken from the request host, which a spoofed `X-Forwarded-Host` can set under a permissive proxy trust, steering a request onto another tenant's host. Hosts outside the allowlist are refused before resolution and before any `findByDomain` lookup. Pair it with trusting `X-Forwarded-Host` only from a proxy you control.
- [ ] Backup storage volume / S3 bucket is encrypted at rest and lifecycle-managed.
- [ ] Rate-limit policy on `RateLimitUnavailableException` is decided and tested (fail-open vs fail-closed).
- [ ] OIDC `client_secret`, encryption keys, and S3 credentials live in a secrets manager, not `.env` checked into git.
- [ ] `APP_KEY` rotation runbook includes `tenant:secrets:reencrypt` (stored webhook/SSO secrets are encrypted under a key derived from `APP_KEY`).
- [ ] `tenant:doctor` runs on a cron in production (the [doctor command](/reference/commands#tenant-doctor)) and pages on `error`-level findings.
- [ ] Health probes wired (`/livez`, `/readyz`, `/healthz`, `/metrics`); see [Health & metrics](/guides/health).

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

- [Compliance (SOC2 & GDPR)](/guides/compliance); how these guarantees map to SOC2/GDPR/ISO/HIPAA controls, plus audit export, anonymization, and the posture report.
- [Concepts](/start/concepts); connection routing, schema model, the boundary the guarantees sit on.
- [Audit logs](/guides/satellites/audit); append-only enforcement details.
- [Quotas](/guides/satellites/quotas); atomic enforcement details.
- [SSO](/guides/satellites/sso); atomic state details.
- [Custom-domain HTTPS](/guides/cookbook/custom-domain-https); TLS termination patterns.

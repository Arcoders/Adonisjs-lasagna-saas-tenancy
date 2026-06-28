---
title: Release notes
description: Auto-generated from the core package's CHANGELOG.md, which is canonical.
---

# Release notes

> Auto-generated from
> [`packages/core/CHANGELOG.md`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/core/CHANGELOG.md)
> at build time. The repo file is canonical.

All notable changes to `@adonisjs-lasagna/saas-tenancy` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-08

The 1.0 cut. The optional satellites move out of the core into their own
independently-versioned packages, and the unified tenant-resolution path becomes
the default. The core now ships only the tenancy primitives plus the leaf
satellites (audit, feature flags, metrics, webhooks, branding, quotas,
impersonation). See the [Upgrade to 1.0 guide](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/reference/upgrade-to-1.0.md)
for a copy-paste migration.

### Breaking changes

- **Satellites are separate packages now.** Billing, SSO, the admin REST API,
  and backup/clone/restore moved out of the core. Install the ones you use and
  update imports:
  - `@adonisjs-lasagna/saas-tenancy/admin` → **`@adonisjs-lasagna/admin`**. The
    old `/admin` subpath is a deprecated throwing shim for one minor, then drops.
  - `SsoService` + `TenantSsoConfig` → **`@adonisjs-lasagna/sso`** (they were
    exported from shared barrels, so there is no shim — the symbols are removed).
  - `BillingService`, the Stripe models, the billing events/jobs,
    `BillingException`, `VerifyStripeWebhookMiddleware`, `multitenancyBillingRoutes`,
    `billingHealthCheck`, `MockStripe` / `signWebhookPayload` →
    **`@adonisjs-lasagna/billing`**. Register `@adonisjs-lasagna/billing/provider`
    and `@adonisjs-lasagna/billing/commands` in `adonisrc.ts`.
  - `BackupService`, `BackupRetentionService`, `CloneService`, `SqlImportService`,
    the `BackupTenant`/`RestoreTenant`/`CloneTenant` jobs, and the
    `tenant:backup*` / `tenant:clone` / `tenant:import` commands →
    **`@adonisjs-lasagna/backup`**. Register `@adonisjs-lasagna/backup/provider`
    and `@adonisjs-lasagna/backup/commands` (this is what registers the
    `backup_recency` doctor check and the backup queue jobs).
  - The result types `BackupMetadata` / `CloneResult` stay in the core
    (`@adonisjs-lasagna/saas-tenancy/types`). The **satellite config types and
    blocks** do NOT: `BillingConfig` / `BillingDriverChoice` now live in
    **`@adonisjs-lasagna/billing`**, and the `billing` / `backup` config blocks
    are contributed onto `MultitenancyConfig` by each satellite via the open
    `SatelliteConfigRegistry` interface (declaration merging) rather than being
    hard-coded into core's frozen type. Authoring `config.billing` / `config.backup`
    is unchanged; only `import { BillingConfig } from '@adonisjs-lasagna/saas-tenancy/types'`
    moves to `from '@adonisjs-lasagna/billing'`. The tenant-lifecycle hook phases
    (`backup`/`restore`/`clone`) and the `TenantBackedUp` / `TenantRestored` /
    `TenantCloned` events also stay in core.
- **`resolver.legacyAdapterFallback` now defaults to `false`.** When a model
  query runs outside an active tenant context, `TenantAdapter` resolves the id
  through the resolver chain synchronously (`resolveSync`) instead of the
  `resolverStrategy`-only switch. Apps using a single built-in strategy are
  unaffected; apps that relied on the old fallback (a custom `resolverChain`
  whose result differs from `resolverStrategy`) set
  `resolver: { legacyAdapterFallback: true }` to restore it.
- **The admin API is fail-closed.** `multitenancyAdminRoutes` now throws at boot
  unless you pass `middleware`, or `middleware: false` to mount it public on
  purpose. (Shipped behind the extraction; see `@adonisjs-lasagna/admin`.)
- **`/metrics` is fail-closed.** The Prometheus output carries per-tenant labels
  (circuit-breaker state, queue depths) and by-status tenant counts, so
  `multitenancyRoutes()` now throws at boot when metrics is enabled without a
  `metricsMiddleware`. Effectively-absent values (`[]`, `''`, `null`) are
  rejected too, so a conditional like `authEnabled ? [auth] : []` cannot mount
  it public silently. Pass `metricsMiddleware: false` to mount it public on
  purpose behind a trusted network boundary, or `metrics: false` to skip the
  endpoint.
- **`CustomDomainMiddleware` is strict by default.** A request whose
  `x-tenant-id` header conflicts with the tenant of a verified custom domain is
  rejected with 400 (`TenantHeaderDomainMismatchException`) before any handler
  runs; the domain is authoritative. The previous default let the header
  override the domain (a tenant-hop vector behind an edge that forwards client
  headers). Opt back into header-wins with `customDomain({ strict: false })`
  only for deliberate header routing on managed domains.
- **`request.tenant()` is fail-closed on tenant lifecycle.** A soft-deleted or
  suspended tenant now throws a 403 (`TenantSuspendedException`) before any
  tenant connection is opened, even on routes that never ran the guard
  middleware — forgetting the guard on a route group can no longer serve a
  suspended tenant. Admin/recovery flows that legitimately need an inactive
  tenant opt in with `request.tenant({ allowInactive: true })`.
- **Webhook signing secrets fail closed.** Delivery now requires the stored
  `tenant_webhooks.secret` to be `enc_v1` ciphertext. `WebhookService.send()`
  decrypted leniently before, so a plaintext, corrupted, or wrong-key secret was
  silently signed with the raw column bytes; it now uses `decryptStrict` and
  marks the delivery failed (no retry) instead of signing with the wrong key.
  Secrets created through `registerWebhook()` are already encrypted and need no
  action. If you ever wrote `tenant_webhooks.secret` directly, run the one-time,
  idempotent `node ace tenant:webhooks:encrypt-secrets` (`--dry-run` to preview)
  before deliveries resume.
- **Stripe SDK type re-exports removed from the core surface.** The
  `StripeEvent` / `StripeSubscription` / `StripeSubscriptionStatus` /
  `StripeCustomer` / `StripeInvoice` / `StripeCheckoutSession` / `StripePrice` /
  `StripeProduct` types and the `stripe` optional peer dependency are gone from
  `@adonisjs-lasagna/saas-tenancy`, so the isolation core no longer couples its
  public surface to one payment provider. Import these from `stripe` directly
  (`import type Stripe from 'stripe'`) or use billing's own types from
  `@adonisjs-lasagna/billing` (which now also owns `BillingConfig` /
  `BillingDriverChoice`).

### Added

- **Four satellite packages**: `@adonisjs-lasagna/admin`, `@adonisjs-lasagna/sso`,
  `@adonisjs-lasagna/billing`, `@adonisjs-lasagna/backup`. Each versions
  independently, ships only its own build, and depends on the core as a peer.
- **Unified tenant resolution** (`resolveSync` over the resolver chain) so custom
  and domain-based resolvers route raw model queries consistently with
  `request.tenant()`. The provider seeds the tenant log context at boot so
  `tenancy.currentId()` reflects the HTTP guard regardless of process history.
- **Connection-eviction safety**: an in-use-aware LRU with a configurable grace
  window (`isolation.maxTenantConnections`, `isolation.evictionGracePeriodMs`,
  `tenantReadReplicas.maxReplicaConnections`) so a burst of distinct tenants can
  no longer release a connection with queries in flight.
- New lightweight subpaths: `@adonisjs-lasagna/saas-tenancy/config` (read config
  outside a booted app) and `/internal` (app.booted-safe building blocks the
  official satellites consume).
- **Audit attribution on the lifecycle commands.** `tenant:create`,
  `tenant:activate`, `tenant:suspend`, `tenant:destroy`, and `tenant:maintenance`
  take an optional `--admin=<id>` flag that attributes the append-only audit row to
  that operator; absent, the row is recorded as `system`.
- Docs: a [Scaling limits](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/guides/scaling-limits.md)
  page and the Upgrade to 1.0 guide.
- **Row-Level Security for `rowscope-pg`.** A new opt-in
  (`configure --with=rls`) publishes a policy migration, plus `withTenantRls()`
  and `setTenantRlsGuc()` helpers that set a transaction-local `app.tenant_id`.
  The policy is fail-closed (an unset tenant matches no rows) and enforced by
  the database regardless of query shape, so a hand-written top-level `orWhere`
  can no longer escape the tenant scope. See
  [rowscope-pg](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/guides/data-isolation/rowscope-pg.md#hard-boundary-postgresql-row-level-security).
- **Optional hard connection cap.** `isolation.enforceConnectionCap` (default
  `false`) makes `maxTenantConnections` a firm ceiling: when it is full and
  nothing is evictable, a new tenant's `connect()` is refused with a 503
  (`TenantConnectionLimitException`) instead of exceeding the cap. The default
  still favours availability (never sever an in-flight request); the hard cap is
  the documented opt-in for deployments fronted by PgBouncer.
- **Opt-in tenant-resolution cache.** `resolver.cache.{enabled, ttlMs, maxEntries}`
  (default off / 10 s / 10 000) serves warm tenants from a bounded per-process
  LRU, cutting the steady-state backoffice round-trips per request from two to
  one. Staleness is bounded by the TTL; the in-process fast-path invalidation
  fires when the matching lifecycle event is emitted (the admin package does
  this — if you suspend tenants another way, emit `TenantSuspended` yourself or
  rely on the TTL). The cached tenant is the same instance for every concurrent
  request in the pod: treat it as read-only and load a fresh instance for any
  mutate-then-save flow.
- **`APP_KEY` rotation support.** Stored secrets (webhook signing secrets, SSO
  client secrets) are encrypted under a key derived from `APP_KEY`, so rotating
  it used to turn them all into permanent decryption failures. New
  `tenant:secrets:reencrypt` command (previous key via the `OLD_APP_KEY` env
  variable, idempotent, `--dry-run`) re-encrypts them under the new key; the
  crypto utils gained `decryptWithAppKey` (rotation) and `decryptStrict`
  (rejects a non-ciphertext value instead of passing it through).
- **`isolation.rowScopeRls` acknowledgment flag.** The provider logs a boot-time
  warning whenever `rowscope-pg` is the active driver without the RLS backstop
  (the mixin alone is convention, not enforcement); setting the flag after
  shipping the `enable_rls_tenant_isolation` migration acknowledges it and
  silences the warning.
- **Stability taxonomy.** A [stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/reference/stability.md)
  labels every feature. The isolation core is `release-candidate` (feature
  complete and green in CI, with `stable` withheld until an independent security
  review and production mileage close); the satellites are `experimental`. The
  labels are mirrored into the package READMEs, and `configure` prints a one-time
  notice when it publishes an experimental satellite.
- **Security policy and operator docs.** A `.github/SECURITY.md` so GitHub
  surfaces the disclosure policy, and a consolidated
  [Production checklist & runbook](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/reference/production-checklist.md)
  (compatibility matrix, pre-flight checklist, failure-mode table, runbook).
- **Canonical performance baseline.** `benchmarks/baselines/1.0.0.json`, captured
  on a Linux runner and aggregated over multiple full-size sweeps, so the
  published numbers are reproducible and the docs drop their provisional caveat. A
  `Capture 1.0.0 baseline` workflow regenerates it on demand.
- **Critical readiness checks.** `health.addCheck(name, fn, { critical: true })`
  marks a check whose failure alone flips `/readyz` to `fail` (503), while
  non-critical failures keep it `degraded` (200). The default `backoffice_db` and
  `redis` checks are critical, so a pod that loses Postgres or Redis is pulled from
  rotation instead of lingering green; `circuit_breakers` stays non-critical so one
  tenant's open circuit cannot unready the whole pod. The provider registers the
  defaults in `boot()` (a host `addCheck` under the same name replaces one,
  `removeCheck` drops it permanently), `registerDefaultChecks(healthService)` is
  exported from `/health`, and `HealthService.isCritical(name)` exposes the flag.
  `TenantMaintenanceException` now renders a `Retry-After` header on its 503.
- **`buildCacheStack(options)` exported from `/services`.** The same factory the
  package's cache singleton is built through (memory L1 + Redis L2 + bus), so tests
  and hosts that need an isolated instance exercise the real production wiring
  instead of copying it.
- **`authorizeTenantAccess` tenant-membership hook.** An opt-in hook on the tenant
  guard that runs after the lifecycle check: returning `false` (or throwing) yields
  a 403 `TenantAccessForbiddenException`. The package routes by tenant id but never
  verified the caller belongs to the resolved tenant, leaving the cross-tenant IDOR
  (a swapped `x-tenant-id`) entirely to the host. It is a membership check, not full
  RBAC; when unset, behavior is unchanged. Ships with a `createTestAuthzContext`
  testing helper and an `@adonisjs/auth` example.
- **Compliance tooling.** Three core ace commands map the existing isolation, audit,
  encryption, and retention features to SOC2 / GDPR / ISO 27001 / HIPAA controls:
  `tenant:audit:export` (stream the immutable audit log to JSON/CSV for GDPR
  Art.15/Art.20), `tenant:gdpr:anonymize <tenantId>` (Art.17 erasure via the new
  `config.compliance.anonymize` seam, recorded in the audit log and dispatching a
  `TenantAnonymized` event), and `tenant:compliance:report` (an extensible control
  registry that introspects real posture, with `--framework`/`--control`/`--json`/
  `--strict`). Additive; no certification is claimed.
- **`TenantJob` base class** (root and `/jobs`). Subclasses implement `perform()`;
  the base `execute()` resolves the tenant from `payload.tenantId` and wraps the
  work in `tenancy.run()` automatically (models, cache, drive, and logging resolve
  to the tenant), running globally when the payload carries no `tenantId`. Removes
  the manual `tenancy.run()` wrapping footgun for host and third-party jobs.
- **`buildTenantWorkerOptions(tenantId, concurrency?)`** on a new `/helpers` subpath.
  Assembles the per-tenant BullMQ `WorkerOptions` (Redis connection, name,
  concurrency) needed to run a dedicated worker per tenant with its own concurrency
  ceiling, so one tenant's job burst cannot starve the others. The package stays
  dispatch-only; the host owns the `Worker` lifecycle.
- **`mapTenants(tenants, fn, options)`** (`/services`). A bounded-concurrency,
  error-isolated tenant fan-out primitive: it runs `fn` inside each tenant's
  `tenancy.run` scope, bounds peak concurrency (default 10), and collects per-tenant
  failures into `errors` instead of aborting the whole run. The safe building block
  for cross-tenant jobs and report extensions.
- **Plan-aware per-tenant rate limiting.** Plans can declare an optional
  `rateLimit: { limit, windowSeconds }` in `config.plans.definitions`, and a new
  `enforceRateLimit()` middleware reads the resolved tenant's plan to apply a
  tier-specific ceiling, so a `free` tenant can be throttled tighter than a `pro`
  tenant without hardcoding limits per route. Reuses the existing Redis
  sliding-window limiter; a plan that omits `rateLimit` is not routable through it.
- **Feature-flag temporal expiry and CLI.** `tenant_feature_flags` gains a nullable
  `expires_at` column and `set()` takes an optional `expiresAt`; once the deadline
  passes, `isEnabled()` returns false (compared at read time, so it is exact
  regardless of the 60s cache). New `FeatureFlagService.getFlag(tenantId, flag)`
  returns the raw `{ enabled, config, expiresAt } | null` record without listing
  every flag, and new `tenant:feature-flag:set|get|list|delete` commands manage
  flags from the CLI. The per-tenant cache key changed (`ff_map:` → `ffm2:`) because
  the cached value shape changed; old entries age out on their own. Re-run
  `configure --with=feature_flags` on a fresh install, or add the column to an
  existing table.
- **`BrandingService.getCurrent()`** resolves the active tenant's branding from the
  ambient `tenancy` context (HTTP request or `tenancy.run(...)`), mirroring
  `tenantMailer()`. Throws outside a tenant scope.
- **`tenant:doctor --fix --interactive`** confirms before fixing each check
  (per check, not per issue). Ignored under `--watch`/`--json`; a no-op without
  `--fix`.
- **Request-metrics pipeline and custom named metrics.** A new opt-in
  `TrackMetricsMiddleware` (`/middleware`) records one request, an error on a
  `>= errorThreshold` (default 500) response, and the response bandwidth against the
  resolved tenant, feeding the `tenant_metrics` table; recording is fail-open and
  bypasses `app.inTest` by default. `MetricsService.emitMetric(tenantId, name,
  value)` plus `flushCustomMetrics()` record host-defined named metrics (integer
  minor units, names validated as safe identifiers) through the same
  Redis → backoffice pipeline; they flush to the new
  `backoffice.tenant_custom_metrics` table (`tenant:metrics:flush` runs both
  flushes) and `emitMetric` dispatches a `MetricRecorded` event (`/events`). New
  installs run the `create_tenant_custom_metrics_table` migration.
- **Per-tenant monthly metrics rollup.** A new `backoffice.tenant_metrics_monthly`
  table (one row per tenant per month), a `tenant:metrics:rollup` command, and
  `MetricsService.recomputeMonthlyRollup()` that collapses the daily
  `tenant_metrics` rows into it. The recompute is idempotent and excludes the
  still-open month by default. New installs run the
  `create_tenant_metrics_monthly_table` migration. Lets the reporting satellite
  serve whole-month, fully-closed windows from a ~30×-smaller table.
- **`MetricsFlushed` event** (`/events`), dispatched by `tenant:metrics:flush` after
  both the built-in and custom flushes succeed (best-effort, fired from the command
  so it neither double-fires nor fires on standalone library use). Lets the
  reporting cache refresh the moment new data lands.
- **Reporting data-freshness helpers.** Pure `mapDataAsOf`/`isStale`/`staleDays`
  helpers (`/services`) and an opt-in `metrics_freshness` doctor check that warns
  when `tenant:metrics:flush` has fallen behind. The check is deliberately not in
  `builtInChecks` (a fresh/empty metrics table would warn forever), so register it
  where you run the metrics pipeline.
- **Public satellite extension platform (`/sdk`).** A new bare-import-safe `/sdk`
  subpath exports the `SatelliteManifest` + `SatelliteProviderContract` types and a
  configure toolkit (`discoverSatellites`, `publishSatellite`,
  `registerSatelliteInRcFile`, the migration-publishing helpers, plus the pure
  `isUuidV4`/`assertSafeIdentifier` validators). `configure` gains
  `--list-satellites` and `--with=<package>` to wire any installed package that
  declares a `lasagnaSatellite` key in its `package.json`. Satellites can declare
  `dependsOn` other satellites (ordered and cycle-checked at configure time), and
  manifest `provider`/`commands` paths are validated as safe relative specifiers.
  `SATELLITE_API_VERSION` (currently `1`) plus `checkSatelliteApiCompat(...)` freeze
  the ABI under the 1.x promise: `configure` refuses to wire a satellite that needs
  a newer ABI than the installed core. The `/testing` barrel is now safe to import
  in a hermetic unit test (it no longer boots a DB connection at import time).
- **`tenant:satellite:remove <package>`** prints a precise, safe checklist for
  removing a packaged satellite (the `adonisrc.ts` lines, the migrations it
  published, its config block, the uninstall command). It never mutates the app or
  drops data.
- **`resolveTenantRepository()` helper** (root and `/services`) centralizes the one
  unavoidable `container.make(TENANT_REPOSITORY as any)` cast that was copy-pasted
  across commands, jobs, middleware, and satellites, so every call site gets a typed
  `TenantRepositoryContract`.
- **Boot-time numeric config validation.** The provider range-checks the numeric
  tunables (connection caps, eviction grace windows, circuit-breaker threshold,
  queue sizes, impersonation durations, ...), so a misconfiguration like
  `isolation.maxTenantConnections: 0` fails fast at boot with a clear message
  instead of misbehaving at runtime.
- **New `BillingConfig` flags read by the billing satellite.** `BillingConfig`
  (inlined in core so it stays decoupled from the billing package) gains an optional
  `fiscal` block (`{ enabled?, automaticTax? }`) and two opt-in flags (default
  `false`) `suspendOnPaymentFailure` / `reactivateOnPaymentSuccess` that drive the
  auto-suspend / reactivate listeners shipped in `@adonisjs-lasagna/billing`. Also
  `config.multitenancy.backup.lockFailOpenOnDestructive?` opts the backup
  satellite's destructive operations back into legacy fail-open locking. Additive
  and optional.
- **OpenTelemetry spans on the tenant hot path.** Tenant activation now opens a
  span carrying `tenant.id` on both the HTTP path (`request.tenant()` →
  `tenancy.http.resolve`, covering resolve + lifecycle + connect) and the
  background path (`tenancy.run()` → `tenancy.run`). Tenant connect runs inside
  the span so its latency is attributed, and deeper code (driver, adapter) that
  calls `TelemetryService.setTenant()` attaches to the active span. When no OTel
  provider is wired (the default) the spans are no-ops, so there is no runtime
  cost.

### Security

- **`rowscope-pg`: closed the `orWhere` scope escape.** The `withTenantScope`
  mixin injects the tenant predicate as a flat clause, so a hand-written
  top-level `orWhere` could compose a query that leaks another tenant's rows.
  The docs now flag any non-grouped top-level `orWhere` as unsafe, and the new
  RLS layer (above) provides a database-enforced boundary that holds regardless
  of query shape.
- **`rowscope-pg`: `before('create')` rejects a cross-tenant `tenant_id`.** A
  create with an explicit `tenant_id` that differs from the active scope now
  throws (consistent with the update/delete hooks) instead of inserting a row
  owned by another tenant.
- **A resolved tenant whose database is down fails closed (503), never central.**
  `request.tenant()`, the tenant guard, and the universal middleware now map an
  unreachable tenant registry or tenant connection to a typed
  `DependencyUnavailableException` (503) instead of degrading to the central
  connection with the wrong tenant context. A permanent misconfiguration (such as
  a missing schema template) surfaces as `IsolationConfigException` (500), so a
  retryable 503 always means "dependency down", never "wrong config". Locked by
  the `connection_failure_503` integration tests.
- **Connection-infrastructure failures fail closed as 503, not raw 500.** A
  backend severed mid-handler (a failover, an admin `pg_terminate_backend`, a
  crash) and a Lucid unregistered-connection error (`E_UNMANAGED_DB_CONNECTION`,
  which carries a 500 but is transient) now map to a retry-able 503 on both the
  guarded and universal paths via a narrow connection-outage classifier — an
  ordinary constraint violation still passes straight through. The universal
  middleware also now connects BEFORE probing the circuit breaker (matching the
  guarded path); previously the probe ran first and failed a tenant's first
  request with an unregistered-connection error. Postgres rolls an aborted
  transaction back, so no partial write survives. Locked by
  `pg_outage_mid_transaction`, `connection_failure_503`, and
  `universal_connection_cap`.
- **`rowscope-pg` cross-tenant isolation holds under concurrency, and the RLS GUC
  is transaction-local.** New proofs cover interleaved writes/reads across many
  tenants on the shared rowscope connection, a query that ignores the RLS
  transaction returning zero rows, and the `app.tenant_id` setting not leaking to
  a reused pooled connection after commit (`rowscope_cross_tenant_concurrent`,
  `rowscope_rls`).
- **Impersonation tokens are bound to the request's tenant.** A token minted for
  tenant A and presented on a request resolved to tenant B is rejected with 401.
  The check no longer depends on the tenant guard running first: when no context
  is active the middleware resolves the request's tenant itself, so the binding
  holds regardless of middleware order. The binding is also enforced under
  domain-based resolution: a `domain`-typed result is resolved to its canonical
  tenant id via `findByDomain` and compared, failing closed on a lookup error
  (previously that path skipped the check). Locked by integration tests.
- **Webhook delivery response bodies are truncated to 4 KB** before persistence,
  so a hostile or oversized webhook target cannot bloat the deliveries table.
- **SSRF guard hardened (internal audit).** Outbound-fetch validation now
  canonicalises IP literals via `node:net`, so an IPv4-mapped IPv6 address in hex
  form (`[::ffff:7f00:1]`, which `new URL` produces for any mapped address) can no
  longer reach loopback/private/metadata ranges. Also closes the partial
  `fe80::/10` link-local range, adds multicast/reserved IPv4 (`224/4`, `240/4`,
  broadcast), and rejects ambiguous numeric IP encodings. SSO `token_endpoint` and
  `jwks_uri` (server-side fetch targets from the tenant-controlled discovery doc)
  now use the DNS-resolving guard, not just the syntactic one. The admin mount
  treats `middleware: null` as fail-closed (like omitting it), not as the explicit
  public opt-out.

### Changed

- **`@adonisjs/queue` is an optional, widened peer.** The range moved from a
  capped `^0.6.0` to `>=0.6.0 <1` (a queue 0.7 release no longer breaks installs),
  and the queue-backed job classes (`InstallTenant` / `UninstallTenant` /
  `TenantJob`, which `extends Job`) are no longer re-exported from the main barrel,
  so `import '@adonisjs-lasagna/saas-tenancy'` stays queue-free. Import them from
  the `@adonisjs-lasagna/saas-tenancy/jobs` subpath when you run a worker.
- **The core is smaller.** It no longer bundles a Stripe engine, an OIDC client,
  a REST admin API, or the backup/clone tooling, so a CVE in any of those no
  longer forces a core bump.
- `CircuitBreakerService` asks the active driver for the connection name instead
  of rebuilding it from the prefix.
- **`rowscope-pg` shares `centralConnectionName`.** The driver now routes its
  single shared connection through the configured `centralConnectionName` rather
  than an unreachable `'tenant'` literal, so `connect`, `destroy`, and the circuit
  breaker's health probe target the database where rowscope data actually lives.
  `templateConnectionName` is a schema-pg/database-pg clone-template knob and is no
  longer consulted by rowscope-pg.
- **Rate-limit attribution prefers the guard's canonical tenant id.**
  `RateLimitMiddleware` keys its bucket on `tenancy.currentId()` first and falls
  back to the synchronous resolver, so domain-resolved tenants no longer collapse
  into one shared per-IP `global` bucket. The per-IP part comes from
  `request.ip()`, which honours `X-Forwarded-For` only per your `trustProxy`
  config — verify it behind a proxy.
- Coverage gate raised to 48 lines / 78 branches / 68 functions on the unit run;
  CI also runs the billing and backup package unit suites and aggregates
  unit + integration coverage.
- **Satellite packages publish as `0.x`** (matching their `experimental`
  stability label), and CI enforces the agreement between stability labels and
  versions mechanically. The published release pipeline is gated on the full CI
  suite passing on the exact commit being released.
- **Curated root barrel.** The concrete built-in isolation drivers
  (`SchemaPgDriver`, `DatabasePgDriver`, `RowScopePgDriver`, `SqliteMemoryDriver`)
  and resolver classes (`HeaderResolver`, `SubdomainResolver`, `PathResolver`,
  `DomainOrSubdomainResolver`, `RequestDataResolver`, `builtInResolvers`) are now
  exported from `/services` only, not the package root. Apps pick a driver by config
  (`isolation.driver`) and resolvers via `TenantResolverRegistry`, so this only
  affects code that imported those implementation classes directly, so switch such
  imports to the `/services` subpath. The extension registries
  (`IsolationDriverRegistry`, `TenantResolverRegistry`) stay on the root.
- **Safer `configure` default.** A bare, non-interactive `node ace configure
  @adonisjs-lasagna/saas-tenancy` no longer auto-publishes every core satellite's
  migrations; it publishes only the core config + tenant model, and you opt into
  satellites explicitly with `--with=`. The interactive prompt preselects nothing.
- **`MultitenancyProvider.shutdown()` is complete.** It now also resets the
  request-resolution caches (resolver registry + resolution cache), so a provider
  re-boot in the same process (hot reload, or a test reusing the container) can't
  serve a stale resolver or cached tenant.
- `engines.node` stays `>=24` (required by AdonisJS 7 / Lucid 22).

### Fixed

- **The opt-in tenant-resolution cache now evicts on lifecycle events.** It never
  did before: the provider wired the invalidation listeners in `boot()` by importing
  the `@adonisjs/core/services/emitter` module, which only assigns its export inside
  an `app.booted()` hook that has not run during `boot()`, so the import resolved to
  `undefined` and every subscription was silently skipped. A suspend / maintenance /
  delete only took effect once the TTL expired. The wiring now runs in `ready()` and
  resolves the emitter from the container, so a lifecycle event drops the cached
  tenant on this pod the moment it fires. No effect when the cache is off (the
  default).
- **Sliding-window rate limiter no longer undercounts same-millisecond requests.**
  The ZSET member was the millisecond timestamp, so two requests in the same
  millisecond collided into one member and `ZCARD` undercounted, letting a burst
  slip past the configured limit. The member now carries a unique per-request
  suffix, so every request is counted.
- **Satellite migration publishing namespaces each file by package** (data-loss
  fix). Two satellites that shipped a stub with the same basename collided before:
  the second was silently skipped and its table was never created. Files are now
  named `<ts>_<pkg_slug>__<stub>.ts` intrinsically; idempotency recognizes both the
  namespaced and legacy un-namespaced forms, so existing installs are not
  re-published as duplicates.
- **`configure --with=metrics` now publishes every metrics table.** The bundle only
  published `create_tenant_metrics_table`; `create_tenant_custom_metrics_table` and
  `create_tenant_metrics_monthly_table` were orphaned (in no bundle), so a host that
  selected `metrics` and emitted a custom metric hit a missing
  `backoffice.tenant_custom_metrics` table on flush (and `tenant:metrics:rollup` a
  missing `tenant_metrics_monthly`). The bundle now publishes all three; existing
  hosts re-run `configure @adonisjs-lasagna/saas-tenancy --with=metrics` (idempotent)
  then `migration:run --connection=backoffice`.
- **README/docs accuracy.** Corrected the package README highlight counts (28 typed
  events, 39 admin endpoints, nine doctor checks), described the satellite *packages*
  as release candidate (only the in-core opt-in features stay experimental), and
  pointed the reference-app snippets at the real `examples/api/docker-compose.yml`.
  These structural counts and the README stability badges are now pinned by CI guards
  so they cannot silently drift again.

---

## [0.2.2] — 2026-06-01

Feature and hardening release. Adds a dependency-resilience degradation
policy and a billing webhook replay fallback, closes several edge-case
failure modes found in a second audit, and activates the coverage gate.
No breaking changes: every new behavior is off by default or preserves the
prior contract. Now 555 unit + 358 integration + 123 e2e.

### Added

- **Dependency resilience policy**. `ResilienceService.run()` is one typed,
  observable contract for what happens when a backing dependency (Redis,
  Postgres, Stripe) is unavailable: `fail-open` returns a fallback,
  `fail-closed` throws `DependencyUnavailableException` (503 + `Retry-After`).
  Configure it per dependency under `config.resilience`, and every
  degradation can emit a `DependencyDegraded` event plus an OpenTelemetry
  span event for alerting. Adopted in `QuotaService` and
  `RateLimitMiddleware`.
- **Billing replay past Stripe's retrieval window**. When Stripe reports an
  event is gone (`resource_missing`), `BillingService.retrieveEvent()`
  reconstructs it from a PII-free, structurally-faithful copy the webhook
  controller persists in `stripe_processed_events.payload`
  (`toReplayablePayload`), so `tenant:billing:replay` works on events older
  than Stripe's ~30-day window.
- **Reference docs**. New Configuration, Exceptions, Troubleshooting, and
  Resilience pages on the docs site.

### Fixed

- **Circuit breaker state survives a restart**. Persisted OPEN state is now
  restored from Redis on process start, so a known-down tenant DB fails fast
  across a deploy instead of being probed back to life.
- **Unified Redis-outage handling in quotas**. `QuotaService.consume/track`
  route through the resilience policy, ending the silent `return 0` and the
  raw ioredis throw on a Redis outage.
- **Smaller correctness and hardening fixes**: `SchemaPgDriver` logs evicted
  connection-release failures instead of swallowing them;
  `assertSafeIdentifier` guards the backup/restore schema name; dead cache
  key removed from the feature-flag service; `SqlImportService` lazy-loads
  its logger so it is unit-testable; `reportUsage` idempotency-key JSDoc
  corrected.

### Changed

- **Coverage gate is live**. `check-coverage` is enforced on the unit run
  (`test:coverage`). The integration coverage run is report-only because it
  executes the compiled `build/` and c8 does not attribute that execution
  back to `src`.
- Test suite grew to 555 unit + 358 integration + 123 e2e.

---

## [0.2.1] — 2026-05-17

Hardening release. Three production-affecting bug fixes uncovered by
a test-coverage audit, plus a substantial integration + E2E expansion
(now 505 unit + 355 integration + 123 e2e).

### Fixed

- **Package queue jobs are now resolvable by `queue:work`**.
  `MultitenancyProvider.boot()` registers `InstallTenant`,
  `UninstallTenant`, `CloneTenant`, `BackupTenant`, `RestoreTenant`,
  `ProcessStripeEventJob`, `BillingCleanupJob`, and `ReportUsageBatchJob`
  with `@adonisjs/queue`'s `Locator`. Pre-fix, host apps' job
  auto-discovery (`app/jobs/**`) didn't reach into `node_modules`, so
  any dispatched package job was dead-lettered at the worker. Jobs are
  registered (and dispatched) under `lasagna.<JobName>` so a host
  app's same-named job can't collide.
- **`CloneService` integer-sequence reset now actually runs**.
  `#resetIntegerSequences` was passing `$1`/`$2` bindings to
  `trx.rawQuery()`; Knex rejects those (it expects `?`), but the
  failure was swallowed by the surrounding savepoint rollback.
  Result: every cloned tenant inherited its source's sequence, so the
  next insert PK-collided with a copied row. Identifiers are now
  interpolated directly into the SQL (guarded by
  `assertSafeIdentifier` upstream).
- **`ImpersonationMiddleware` constructor no longer breaks IoC
  resolution**. The optional typed constructor parameter forced the
  AdonisJS container to try injecting `ImpersonationService` at
  middleware resolution time, which it can't (the service needs a
  config-validated boot). Refactored to a `protected getService()`
  seam that subclasses can override for tests.

### Changed

- **Build artefact no longer embeds TypeScript source**.
  `inlineSources: true` removed from `tsconfig.json`. `.js.map` files
  in `build/` still reference `.ts` paths for stack traces but no
  longer carry the full source bytes — smaller install footprint for
  consumers.
- **Test coverage tooling**. Added `c8` with `test:coverage` /
  `test:integration:coverage` scripts and `.c8rc.json` (thresholds
  report-only at 0; ratchet after a baseline is captured). CI uploads
  `lcov.info` as an artifact.
- **CI provisions MinIO + mock-oauth2-server** so the new S3 / OIDC
  integration specs run against real backends. Optional
  `STRIPE_TEST_API_KEY` secret enables the Stripe live-API smoke
  test; without it the spec reports itself skipped.

### Test coverage

Closing the gap between "lots of tests" and "production confidence".
New end-to-end coverage for previously-thin paths:

- `examples/api/tests/e2e/commands_lifecycle.spec.ts` (10 tests) —
  real ace command execution for `tenant:list`/`suspend`/`activate`/
  `import`/`purge-expired`/`maintenance`/`impersonate`/`backups:run`/
  `webhooks:retry`.
- `examples/api/tests/e2e/queue_jobs.spec.ts` (2 tests) — real
  `queue:work` subprocess provisioning and tearing down tenants.
- `tests/integration/services/backup_s3.spec.ts` (real MinIO),
  `sso_oidc_real.spec.ts` (real `mock-oauth2-server`),
  `stripe_real_smoke.spec.ts` (real Stripe test API).
- `tests/integration/middleware/rate_limit.spec.ts` (6 tests, real
  Redis pipeline) and `impersonation_middleware.spec.ts` (real HTTP +
  Redis).
- `tests/integration/services/bootstrapper_isolation.spec.ts` (9
  tests, cross-tenant isolation + 16-way `AsyncLocalStorage`
  concurrency), `clone_service.spec.ts`, `doctor_checks_real.spec.ts`,
  `telemetry_export.spec.ts` (with real OTel SDK +
  `AsyncLocalStorageContextManager`).
- `tests/integration/billing/diagnostics_commands.spec.ts`
  (`tenant:billing:doctor` + `tenant:billing:test-webhook`).
- `tests/integration/billing/stripe_real_smoke.spec.ts` expanded to
  cover every Stripe SDK call-site.

### Upgrade notes

- **Drain your queue before upgrading** if you have unprocessed
  package jobs in Redis under the old names (`InstallTenant`,
  `UninstallTenant`, etc.). After upgrade, the worker resolves them
  under `lasagna.<JobName>`, so any pending pre-upgrade jobs will
  dead-letter at the worker.
- **Subclassers of `ImpersonationMiddleware`**: the constructor
  parameter is gone. Override `getService()` instead of injecting via
  `new ImpersonationMiddleware(service)`.

---

## [0.2.0] — 2026-05-09

Adds the **Stripe billing satellite** as the ninth opt-in feature.
Opt in with `node ace configure @adonisjs-lasagna/saas-tenancy --with=billing`
and `npm install stripe@^18`.

### Added

- **Billing satellite** — full Stripe integration:
  - Idempotent webhook receiver (`POST /webhooks/stripe`) with raw
    `INSERT ... ON CONFLICT (event_id) DO NOTHING`. HMAC-SHA256
    signature verification. Optional IP allowlist supporting both
    literal and CIDR entries via `node:net.BlockList` (zero deps).
  - Configurable dunning state machine (`maxAttempts`, `action`,
    `gracePeriodDays`) matching Stripe Smart Retries.
  - Metered billing — `BillingService.reportUsage()` plus the
    `usageMapping` auto-bridge that batches `QuotaTracked` events
    into a single `ReportUsageBatchJob` per `(tenant, meter)`.
  - Checkout (`createCheckoutSession`) and Billing Portal
    (`createBillingPortalSession`) helpers.
  - Tenant hard-delete policy (`onTenantDelete`: `cancel` / `detach`
    / `preserve`) wired via `HookRegistry.beforeDestroy`.
- **6 ace commands**: `tenant:billing:sync`, `tenant:billing:backfill`,
  `tenant:billing:replay`, `tenant:billing:cleanup`,
  `tenant:billing:doctor`, `tenant:billing:test-webhook`.
- **10 events**: `SubscriptionActivated`, `SubscriptionUpdated`,
  `SubscriptionCanceled`, `SubscriptionPaused`, `SubscriptionResumed`,
  `TrialEnding`, `PaymentSucceeded`, `PaymentFailed`,
  `BillingMisconfigured`, `BillingEventDeadLettered`.
- **3 jobs**: `ProcessStripeEventJob`, `ReportUsageBatchJob`,
  `BillingCleanupJob`.
- **4 satellite tables**: `stripe_customers`, `stripe_subscriptions`,
  `stripe_processed_events`, `stripe_meter_events`. Plus
  `tenant_plans` (shared with the quotas satellite).
- **Health check** `billingHealthCheck` (Stripe API ping + webhook
  freshness; `SLOW_API_THRESHOLD_MS` exported for test tuning).
- **Testing helpers** under `@adonisjs-lasagna/saas-tenancy/testing`:
  `MockStripe` (in-memory SDK double) and `signWebhookPayload`.
- **PII redaction**: `redactStripeEvent()` strip-list (whitelist) for
  webhook payloads and structured logs. `BillingEventDeadLettered`
  carries a stable `errorCode` enum, never raw `error.message`.
- **Documentation**: full reference at
  [Billing satellite](/guides/satellites/billing); end-to-end recipe
  at [Stripe + quotas (cookbook)](/guides/cookbook/stripe-quotas).

### Changed

- Total ace command count is now 33 (was 27).
- Total typed events is now 23 (13 tenant lifecycle + 10 billing).
- Total bundled jobs is now 8 (5 tenant + 3 billing).
- Boot guard: `BillingService.verify()` now **throws** when a
  `sk_live_*` key is loaded outside production without
  `STRIPE_ALLOW_LIVE_IN_DEV=true` (was warn-only). Same hard-fail in
  the other direction (`sk_test_*` + `NODE_ENV=production`).
- `multitenancy.stub` adds `/webhooks/stripe` to the default
  `ignorePaths`. Hosts that change `webhook.path` must update
  `ignorePaths` accordingly.

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


---

## Satellite packages

The satellites version independently of the core. Each keeps its own canonical changelog in
the repo:

| Package | Current version |
|---|---|
| [`@adonisjs-lasagna/sso`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/sso/CHANGELOG.md) | 1.0.0 |
| [`@adonisjs-lasagna/billing`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/billing/CHANGELOG.md) | 1.0.0 |
| [`@adonisjs-lasagna/admin`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/admin/CHANGELOG.md) | 1.0.0 |
| [`@adonisjs-lasagna/backup`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/packages/backup/CHANGELOG.md) | 1.0.0 |

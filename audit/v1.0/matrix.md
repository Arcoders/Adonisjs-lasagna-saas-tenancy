# v1.0 Documentation Verification Matrix

Seeded 2026-06-10 from the extracted claims checklist (972 IDs) + Wave-0 re-sweep.

**Status enum:** VERIFIED | IMPL-ONLY | PARTIAL | DOC-ONLY | BROKEN | N/A
**Tiers:** A = guarantee/failure-mode (assertion-level spec reading required) · B = existence (grep-verifiable) · C = narrative/meta (explicit disposition, no evidence burden)
**Rule:** a Tier-A row may only be VERIFIED after the auditor has personally read the cited spec's assertions; Test evidence cites the verbatim test title.


## index.md (Home)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [home#1] | "Each tenant lives in its own PostgreSQL schema. No tenant_id leaks into your queries, and a cross-tenant read throws instead of returning the wrong rows." | A | VERIFIED | schema_pg_driver.ts (per-schema routing); scoping.ts:135 (strict throw) | cross_tenant_e2e.spec.ts:71 (zero cross-reads under concurrency); rowscope_pg_driver.spec.ts:232 (throw on missing scope) | none | "throws" = strict-scope path; schema-pg prevents by routing |
| [home#2] | "Four isolation drivers: schema-pg, database-pg, rowscope-pg, and an in-memory SQLite driver for tests." | B | VERIFIED | src/services/isolation/{schema,database,rowscope}_pg_driver.ts + sqlite_memory_driver.ts | per-driver unit + integration specs | none | |
| [home#3] | "Cache, drive, mail, sessions, broadcasts, and queued jobs all resolve the active tenant through AsyncLocalStorage." | B | VERIFIED | bootstrappers ×5 + tenancy.run in jobs (install_tenant.ts, tenant_context) | bootstrapper_isolation.spec.ts; jobs/tenant_context.spec.ts:72; e2e mail/queue_jobs | none | |
| [home#4] | "A doctor command that fixes things, scheduled backups with retention tiers, restore, clone, and a REST admin API described by an OpenAPI spec." | B | VERIFIED | tenant_doctor.ts (--fix); packages/backup (retention/restore/clone); packages/admin (OpenAPI 3.1) | doctor_checks_real.spec.ts; backup pkg specs + e2e backups_real; admin openapi.spec.ts + e2e admin_full | none | backups need @adonisjs-lasagna/backup installed |
| [home#5] | "Audit logs, feature flags, signed webhooks, branding, SSO, metrics, quotas, and Stripe billing." | B | VERIFIED | core satellites + packages/sso + packages/billing | per-satellite integration specs (W4 deepens) | none | |
| [home#6] | "Circuit breakers, read replicas, health probes, Prometheus metrics, and OpenTelemetry spans." | B | VERIFIED | circuit_breaker_service.ts:1,25 (opossum per tenant); read_replica_service.ts; health/; metrics_exporter.ts; telemetry_service.ts | unit+integration circuit specs; read_replica_resolve; health_service.spec; telemetry_export.spec | none | |
| [home#7] | "A Dockerfile, docker-compose, and Helm chart ship with it." | B | VERIFIED | deploy/Dockerfile, deploy/docker-compose.prod.yml, deploy/charts/lasagna-app/Chart.yaml | — (artifacts, not behavior) | none | |

## quickstart.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [quickstart#1] | Command: `npm install @adonisjs-lasagna/saas-tenancy` | B | VERIFIED | packages/core/package.json name=@adonisjs-lasagna/saas-tenancy v1.0.0 | — | none | |
| [quickstart#2] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks` | B | VERIFIED | configure.ts (--with parsing) | configure.spec.ts (24 tests: flag parsing, bundles, idempotency) | none | |
| [quickstart#3] | Command: `node ace backoffice:setup` - "Creates the backoffice schema and runs all satellite-table migrations in one shot. Idempotent; re-run any time." | B | PARTIAL | setup_backoffice.ts (CREATE SCHEMA IF NOT EXISTS + MigrationRunner; in-version idempotent via Lucid bookkeeping) | e2e runs it once; no re-run test | new-test:T10 (e2e re-run) code-fix:F-4 (error swallowed) | |
| [quickstart#4] | Command: `node ace tenant:create "Acme Corp" "admin@acme.example.com"` - "Insert a tenant row and queue InstallTenant" | B | VERIFIED | create_tenant.ts (args name,email; dispatches TenantCreated, queues InstallTenant) | e2e commands_lifecycle.spec.ts | none | |
| [quickstart#5] | Command: `node ace queue:work` - "in another terminal — provisions the schema" | B | VERIFIED | @adonisjs/queue peer; install_tenant.ts:34-38 provision→active | e2e queue_jobs + lifecycle | none | |
| [quickstart#6] | Command: `node ace tenant:migrate` - "apply your tenant migrations into the new schema" | B | VERIFIED | tenant_migrate.ts (alias of migration:tenant:run) | e2e commands_lifecycle.spec.ts | none | |
| [quickstart#7] | Command: `node ace tenant:doctor` - "checks your connections, schema health, and configuration. A green report means the tenant is provisioned and routable." | B | VERIFIED | tenant_doctor.ts + 9 built-in checks | doctor_checks_real.spec.ts; e2e commands_misc | doc-fix:F-11 (check count, if quickstart names ten) | |
| [quickstart#8] | Import: `@adonisjs-lasagna/saas-tenancy` - Main package | B | VERIFIED | package.json exports "." | — | none | |
| [quickstart#9] | Import: `TENANT_REPOSITORY` from `@adonisjs-lasagna/saas-tenancy` | B | VERIFIED | src/index.ts:9 re-exports from types/contracts.js | fixture app binds it | none | |
| [quickstart#10] | Macro: `request.tenant()` - "Memoised per request, same reference no matter how many times you call it." | A | VERIFIED | extensions/request.ts (Symbol memo) | request_tenant_memo.spec.ts:5 "returns the same object reference on repeated calls within one request" + :43 cross-request independence | none | |
| [quickstart#11] | Config requirement: Database connections with `public`, `backoffice`, and `tenant_<uuid>` schemas | B | VERIFIED | fixture config/database.ts (3 connections w/ searchPath) | integration suite boots on it | none | |
| [quickstart#12] | Config: `TenantRepository` binding with methods `findById`, `findByDomain`, `all(filters)` | B | VERIFIED | types/contracts.ts TenantRepositoryContract; fixture tenant_repository.ts | exercised by every integration spec | none | |
| [quickstart#13] | "Once the InstallTenant job finishes, the row flips to status: 'active' and tenant-scoped routes light up." | A | VERIFIED | install_tenant.ts:37 status='active' after driver.provision (failed on error :40) | isolation/tenant_lifecycle.spec.ts; e2e full.spec.ts provisioning flow | none | |

## security.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [security#1] | "No DDL injection via `tenant.id` — `assertSafeIdentifier()` rejects anything that could escape a quoted PG identifier" | A | VERIFIED | src/services/isolation/identifier.ts:9,23 (SAFE_IDENT whitelist, ≤63); called in all 4 drivers + bootstrappers + rls + cache + setup_backoffice | tests/unit/services/identifier.spec.ts — "rejects double quotes (the canonical PG identifier escape vector)", "rejects semicolons and statement terminators", "rejects shell metacharacters", "rejects ids over 63 characters" | none | |
| [security#2] | "No `shell: true` in `spawn(...)` — `pg_dump`, `pg_restore`, and `psql` are spawned without a shell on every platform" | A | IMPL-ONLY | backup_service.ts:256, sql_import_service.ts:303,331 — argv arrays, no shell:true; #psqlBinary() comment documents the vector | — (no architectural test enforces it) | new-test:T3 no_shell_spawn.spec.ts | |
| [security#4] | "No silent cross-tenant write — Bulk `Model.query().delete()` / `.update()` on a scoped model are intercepted by the `before('fetch')` hook" | A | PARTIAL | scoping.ts:149-166 — real mechanism is the wrapped static query() factory (source says before:fetch does NOT fire for builder DELETE/UPDATE) | rowscope_pg_driver.spec.ts:238 — "bulk delete via query builder is scoped" (real Lucid+PG); bulk UPDATE untested | code-fix:F-7 (+bulk-update test) doc-fix:F-7 | outcome true; mechanism mis-described |
| [security#3] | "No silent cross-tenant fetch — A `withTenantScope`-backed model queried outside both `tenancy.run()` and `unscoped()` throws `MissingTenantScopeException` instead of returning every tenant's rows" | A | VERIFIED | scoping.ts:135 (strict default via rowScopeMode ?? 'strict' at :50) | unit scoping.spec.ts:202 "find/fetch/paginate hooks throw when no scope is active"; integration rowscope_pg_driver.spec.ts:232 "strict mode throws when a query runs without tenancy.run() and without unscoped()" | none | |
| [security#5] | "Tenant routing only on valid UUID v4 — `TenantAdapter.modelConstructorClient()` validates the resolved tenant id before picking the Lucid connection" | A | VERIFIED | tenant_adapter.ts:64 assert(isUuidV4(tenantId)) | tenant_adapter.spec.ts:183 "throws MissingTenantHeaderException when tenant ID is not a valid v4 UUID", :198 v3 UUID, :476 non-UUID subdomain | none | |
| [security#6] | "Atomic quota enforcement — `QuotaService.consume()` issues a single `EVAL` (Lua) round-trip" | A | PARTIAL | quota_service.ts:364-418 single EVAL; fail-open on Redis outage by default (:372,:396) | quota_concurrency.spec.ts asserts only isAtMost/isAtLeast + stale "near-atomic" comment | test-fix:T0 doc-fix:F-2 (Redis qualifier) | |
| [security#7] | "Atomic SSO state — `SsoService` reads the OAuth/OIDC `state` parameter via Redis `GETDEL` so a replayed callback can never re-validate" | A | VERIFIED | packages/sso/src/sso_service.ts:89 redis.getdel | sso_oidc_flow.spec.ts:291 "state can only be used once (replay rejected)", :313 "concurrent callbacks with the same state — exactly one wins (atomic state consumption)" | none | T6 dropped — already covered |
| [security#8] | "Append-only audit at SQL level — `tenant_audit_logs` migration installs BEFORE UPDATE/DELETE/TRUNCATE triggers that all RAISE EXCEPTION" | A | VERIFIED | stubs/migrations/create_tenant_audit_logs_table.stub:30-53 (3 triggers incl. statement-level TRUNCATE) | audit_immutability.spec.ts:57 "UPDATE raises an exception" (ORM + raw + row-unchanged), :93 DELETE, :121 "TRUNCATE is blocked — statement-level trigger closes the per-row bypass" | none | |
| [security#9] | "Strict domain mode rejects header/domain hijack — CustomDomainMiddleware({strict:true}) throws TenantHeaderDomainMismatchException (HTTP 400)" | A | VERIFIED | src/middleware/custom_domain_middleware.ts (strict branch) | header_vs_domain_precedence.spec.ts:27 "strict: rejects with 400 when header disagrees with the host-resolved tenant" + 4 more cases incl. port suffix | none | |
| [security#10] | "Bounded connection pool — fixture Tenant model demonstrates an LRU cap (50 by default); hosts should keep this LRU pattern in their Tenant implementation" | A | PARTIAL | connection_lru.ts:5 DEFAULT_MAX_TENANT_CONNECTIONS=50 — LRU is IN THE PACKAGE (drivers), not host-implemented | connection_lru.spec.ts (17 unit tests); universal_connection_cap.spec.ts (hard cap 503) | doc-fix:F-8 | doc understates: tells hosts to hand-roll what core now owns |
| [security#11] | "No singleton retention across boots — provider.shutdown() invalidates the module-level caches" | A | IMPL-ONLY | multitenancy_provider.ts:298-307 (__configureTenancyForTests({}) + __resetActiveDriverCache()) | — (no spec exercises shutdown) | new-test:T8 provider_shutdown.spec.ts | |
| [security#12] | "Admin REST API fail-closed: multitenancyAdminRoutes() throws at startup unless middleware passed, or middleware:false for deliberate public" | A | IMPL-ONLY | packages/admin/src/routes.ts:130-140 | — (admin tests only cover openapi; e2e only exercises the happy path) | new-test:T9 admin routes fail-closed unit | |
| [security#13] | "Rate-limit availability — RateLimitUnavailableException; host decides fail-open (502) or fail-closed (429)" | A | BROKEN | rate_limit_middleware.ts: default failOpen:false, throws RateLimitUnavailableException (5xx); failOpen:true lets request proceed | rate_limit.spec.ts (verify status in W6) | doc-fix:F-3 | status-code framing wrong; contradicts why.md |
| [security#14] | Test: cross-tenant leak under concurrent writes — 5 tenants × 20 concurrent POST/GET | A | VERIFIED | — | cross_tenant_e2e.spec.ts:71 "5 tenants × 20 concurrent writes — no cross-tenant leak on read" (constants :8-9 match doc) + :134 durability test | doc-fix:F-5 (stale GitHub URL only) | |
| [security#15] | Test: job-context leak under interleaved tenants — 3 tenants × 30 shuffled jobs | A | VERIFIED | — | tenant_context.spec.ts:72 "tenancy.currentId() and per-schema writes are correctly scoped under high concurrency" (constants :9-10 = 3×30) | doc-fix:F-5 (URL) | |
| [security#16] | Test: audit row tampering (UPDATE/DELETE/TRUNCATE) — verifies all three triggers reject ORM and raw attempts | A | VERIFIED | — | audit_immutability.spec.ts:57,:93,:121 — ORM .save()/.delete() AND raw query paths both asserted, row content re-checked | doc-fix:F-5 (URL) | |
| [security#17] | Test: quota over-grant under burst — atomic Lua check survives N concurrent consume() | A | PARTIAL | — | quota_concurrency.spec.ts — assertions weaker than claim (isAtMost; tolerates under-grant; stale pre-Lua comment) | test-fix:T0 | |
| [security#18] | Test: SSO state CSRF/replay — replay of state returns 401, never 200 | A | VERIFIED | — | sso_oidc_flow.spec.ts:291 sequential replay + :313 concurrent "exactly one wins" | doc-fix:F-5 (URL) | |
| [security#19] | Test: header-vs-domain hijack — strict rejects mismatch; header-only and domain-only behave as documented | A | VERIFIED | — | header_vs_domain_precedence.spec.ts:27,:52,:73,:90,:110 (5 cases) | doc-fix:F-5 (URL) | |
| [security#20] | Test: cache namespace collision — per-tenant BentoCache namespaces never share keys | A | VERIFIED | — | cache_for.spec.ts:24 "two tenants writing the same key see independent values", :51 "rejects unsafe tenant ids before reaching Redis (key injection guard)" | doc-fix:F-5 (URL) | |

## why.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [why#1] | "covers the same ground (4 isolation drivers, 6 bootstrappers, 5 resolvers, full lifecycle hooks…) and adds doctor, replicas, OTel, Prometheus, backups, impersonation, quotas, admin API" | C | PARTIAL | drivers=4 ✓; resolvers=5 ✓ (builtins.ts:19-106); bootstrappers=5 NOT 6 (provider:147-264) | — | doc-fix:F-10 | stancl-side cells not auditable |
| [why#2] | "The full feature surface lives in examples/api … an end-to-end suite covering every feature." | C | PARTIAL | examples/api wires all satellites | e2e = 125 tests, broad but "every feature" is absolute (e.g. database-pg driver not exercised in e2e) | doc-fix (soften in W7) | |
| [why#3] | "Circuit breaker per tenant — Opossum-backed, scoped to each tenant's database access. One bad schema can't take the others down." | A | VERIFIED | circuit_breaker_service.ts:1 (opossum), :25 Map per tenant | unit circuit_breaker_service.spec.ts (18: transitions, instance isolation); integration (Redis persistence) | none | |
| [why#4] | "Quota atomicity — consume() in a single Redis Lua script. 50 parallel vs limit=10 → exactly ten successes, forty QuotaExceededException. No race window." | A | PARTIAL | quota_service.ts:364-418 single EVAL ✓; fail-open Redis caveat (:372) | quota_concurrency.spec.ts asserts only bounds, not exactness | test-fix:T0 doc-fix:F-2 | |
| [why#5] | "SSO replay protection — state consumed via atomic GETDEL; two concurrent callbacks with the same state can never both succeed." | A | VERIFIED | packages/sso/src/sso_service.ts:89 | sso_oidc_flow.spec.ts:313 "concurrent callbacks with the same state — exactly one wins (atomic state consumption)" | none | |
| [why#6] | "Audit log immutability — Postgres triggers block UPDATE, DELETE, TRUNCATE" | A | VERIFIED | create_tenant_audit_logs_table.stub:30-53 | audit_immutability.spec.ts:57,:93,:121 | none | |
| [why#7] | "Header-vs-domain hijack — customDomain({strict:true}) rejects, 400 E_TENANT_HEADER_DOMAIN_MISMATCH" | A | VERIFIED | custom_domain_middleware.ts strict branch | header_vs_domain_precedence.spec.ts:27 | none | |
| [why#8] | "Rate-limit fails closed — Redis down means 503, never silent fail-open. Opt into failOpen: true." | A | VERIFIED | rate_limit_middleware.ts default failOpen:false; rate_limit_unavailable_exception.ts:4 status=503 | rate_limit.spec.ts:93 "fail-closed (default): Redis outage → 503 RATE_LIMIT_UNAVAILABLE", :133 fail-open passthrough | none | security.md contradicts → F-3 fixes that page |
| [why#9] | "Doctor checks against real state — long_running_queries, replica_lag, queue_stuck run in CI against live Postgres / BullMQ" | A | VERIFIED | doctor checks ×9 | tests/integration/doctor/{long_running_queries,replica_lag,queue_stuck}.spec.ts run in CI integration job | none | |
| [why#10] | "tenant:doctor with ten built-in checks, --fix, --json, --watch, plugin API" | B | PARTIAL | core ships 9 checks; 10th (backup_recency) registers from @adonisjs-lasagna/backup; flags exist in tenant_doctor.ts | doctor_checks_real.spec.ts; e2e commands_misc | doc-fix:F-11 | |
| [why#11] | "Backups with retention tiers: pg_dump, S3 mirror, JSON sidecar with checksums, tier intervals, per-tenant resolution" | B | VERIFIED | packages/backup services (pg_dump spawn :256, S3, retention tiers) | backup pkg unit specs ×5; integration backup_s3.spec.ts; e2e backups_real.spec.ts | new-test:T7 (corruption failure case) | sidecar checksum *verification* depth checked in T7 |
| [why#12] | "An architectural test fails CI if any future rawQuery interpolates a template variable without assertSafeIdentifier" | A | VERIFIED | — | tests/architectural/no_unsafe_raw_sql.spec.ts:76 "every file that interpolates into rawQuery imports assertSafeIdentifier or opts out per line" + :117 positive controls | none | |
| [why#13] | why.md:186 links `tests/integration/` at repo root on GitHub | B | BROKEN | actual path packages/core/tests/integration | — | doc-fix:F-5 | |

## introduction.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [intro#1] | "Four isolation drivers: schema-pg (default), database-pg, rowscope-pg, sqlite-memory. Pluggable through a single contract." | B | | | | | |
| [intro#2] | "Five bootstrappers: cache, drive (filesystem), mail, session, broadcasting. Each scoped to the active tenant via AsyncLocalStorage." | B | | | | | |
| [intro#3] | "Nine satellites: audit logs, feature flags, webhooks, branding, SSO, metrics, quotas, impersonation, Stripe billing." | B | | | | | |
| [intro#4] | "Operational kit: tenant:doctor (ten checks, --fix, --watch, --json), backups with retention tiers, read replicas, Prometheus, OpenTelemetry, health probes" | B | | | | | |
| [intro#5] | "A full suite of ace commands spanning provisioning, migrations, backups, cloning, exec-under-tenant, maintenance mode, REPL, billing." | B | | | | | |
| [intro#6] | "REST admin API with an OpenAPI 3.1 spec and Swagger UI." | B | | | | | |
| [intro#7] | "MySQL or MariaDB — Schemas are a Postgres-native concept" | B | | | | | |
| [intro#8] | "An admin dashboard UI — Only the REST API" | B | | | | | |
| [intro#9] | "A starter kit — create-lasagna-saas is roadmap" | B | | | | | |

## concepts.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [concepts#1] | "Layer 1: Central (public schema) — your product-wide data" | B | | | | | |
| [concepts#2] | "Layer 2: Backoffice (backoffice schema) — tenant registry + operator tools" | B | | | | | |
| [concepts#3] | "Layer 3: Tenant (tenant_<uuid> schema) — one schema per customer" | B | | | | | |
| [concepts#4] | "Layer 4: Satellites (opt-in features stored in backoffice schema) — audit, feature_flags, webhooks, branding, sso, metrics, quotas, impersonation" | B | | | | | |
| [concepts#5] | "The active isolation driver decides which Lucid connection serves a query" | B | | | | | |
| [concepts#6] | "The bootstrapper registry enters and leaves per-tenant contexts" | B | | | | | |
| [concepts#7] | "AsyncLocalStorage carries the active tenant id, so logs, queries, and queued jobs all see the same context" | B | | | | | |

## installation.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [install#1] | "Node.js ≥ 24 — ES modules, module: NodeNext" | B | | | | | |
| [install#2] | "AdonisJS 7" | B | | | | | |
| [install#3] | "PostgreSQL ≥ 14 via @adonisjs/lucid" | B | | | | | |
| [install#4] | "Redis ≥ 6 via @adonisjs/redis — cache + counters" | B | | | | | |
| [install#5] | "@adonisjs/queue required — background jobs provision schemas" | B | | | | | |
| [install#6] | "@aws-sdk/client-s3 optional — only for S3 backup uploads" | B | | | | | |
| [install#7] | "jose optional — only when SSO is enabled" | B | | | | | |
| [install#8] | Command: `npm install @adonisjs-lasagna/saas-tenancy` | B | | | | | |
| [install#9] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy` (without --with: all satellites) | B | | | | | |
| [install#10] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks` | B | | | | | |
| [install#11] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --no-interaction --with=audit,branding,feature_flags` | B | | | | | |
| [install#12] | "Three connection contexts live side by side: public (global data), backoffice (tenant registry + satellite features), tenant_<uuid> (per-tenant data)" | B | | | | | |
| [install#13] | "Tenant connections are created at runtime, no entry needed in config/database.ts" | B | | | | | |
| [install#14] | "searchPath: 'public'" for public connection | B | | | | | |
| [install#15] | "searchPath: 'backoffice'" for backoffice connection | B | | | | | |
| [install#16] | Command: `node ace backoffice:setup` — Creates backoffice schema and runs all satellite migrations | B | | | | | |
| [install#17] | Command: `node ace tenant:create "name" "email"` | B | | | | | |
| [install#18] | Command: `node ace queue:work` | B | | | | | |
| [install#19] | Command: `node ace tenant:migrate` | B | | | | | |
| [install#20] | Middleware: `TenantGuardMiddleware` — resolves tenant and memoizes | B | | | | | |
| [install#21] | Middleware: `CustomDomainMiddleware` — maps custom domains to tenants | B | | | | | |
| [install#22] | Middleware: `RateLimitMiddleware` — **fail-closed by default**: if Redis unreachable, throws RateLimitUnavailableException (HTTP 503) | B | | | | | |
| [install#23] | Option on RateLimitMiddleware: `failOpen: true` — per-route option to fail-open | B | | | | | |
| [install#24] | "RateLimitMiddleware is fail-closed by default" | A | | | | | |
| [install#25] | "The middleware short-circuits when `app.inTest === true`" | A | | | | | |
| [install#26] | Command: `node ace tenant:migrate` and `node ace queue:work` are separate steps; InstallTenant creates the schema empty, tenant:migrate applies migrations | A | | | | | |

## tenant-identification.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [resolve#1] | Strategy: `header` (default) — Reads `x-tenant-id` from request headers | B | | | | | |
| [resolve#2] | Strategy: `subdomain` — Extracts UUID from `<uuid>.yourdomain.com` | B | | | | | |
| [resolve#3] | Strategy: `path` — Reads the first path segment `/<uuid>/...` | B | | | | | |
| [resolve#4] | Strategy: `request-data` — Reads from query string or body | B | | | | | |
| [resolve#5] | Strategy: `domain-or-subdomain` — Custom domain wins, falls back to subdomain | B | | | | | |
| [resolve#6] | Config key: `resolverStrategy` — set to 'header', 'subdomain', 'path', 'domain-or-subdomain', or 'request-data' | B | | | | | |
| [resolve#7] | Config key: `tenantHeaderKey` (defaults to 'x-tenant-id') | B | | | | | |
| [resolve#8] | Config key: `baseDomain` — for subdomain strategy | B | | | | | |
| [resolve#9] | Config: `requestData.queryKey` (default 'tenant_id') — ?tenant_id=<uuid> | B | | | | | |
| [resolve#10] | Config: `requestData.bodyKey` (default 'tenant_id') — { "tenant_id": "<uuid>" } | B | | | | | |
| [resolve#11] | Macro: `request.tenant()` — memoized per request, returns the resolved tenant | B | | | | | |
| [resolve#12] | "Always call this helper rather than reading the header directly" | A | | | | | |
| [resolve#13] | Interface: `TenantResolver` contract for custom resolvers | B | | | | | |
| [resolve#14] | API: `ResolverRegistry.register('name', resolver)` in provider | B | | | | | |
| [resolve#15] | Config: `resolverChain: ['header', 'subdomain', 'request-data']` — first hit wins | B | | | | | |
| [resolve#16] | Overrides `resolverStrategy` when set | A | | | | | |
| [resolve#17] | Config: `resolver.legacyAdapterFallback` (defaults to false) — controls synchronous fallback for model queries outside request guard | B | | | | | |
| [resolve#18] | Default (false): adapter consults the resolver chain synchronously | B | | | | | |
| [resolve#19] | True: restores 0.x behavior — adapter uses only `resolverStrategy` on fallback | B | | | | | |

## routing.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [routing#1] | Macro: `router.tenant()` — Wraps with `TenantGuardMiddleware`, requires resolved tenant | B | | | | | |
| [routing#2] | Macro: `router.central()` — Wraps with `CentralOnlyMiddleware`, requires NO tenant in scope | B | | | | | |
| [routing#3] | Macro: `router.universal()` — Wraps with `UniversalMiddleware`, resolves tenant when present, never fails when absent | B | | | | | |
| [routing#4] | Middleware: `CustomDomainMiddleware` — queries `findByDomain(host)` from tenant repository | B | | | | | |
| [routing#5] | Option: `strict: true` — rejects conflicting header/domain with HTTP 400 (`E_TENANT_HEADER_DOMAIN_MISMATCH`) | B | | | | | |
| [routing#6] | Default: explicit `x-tenant-id` header wins over Host-resolved tenant | B | | | | | |
| [routing#7] | `strict: true` mode: rejects when header disagrees with domain | B | | | | | |
| [routing#8] | API: `tenancy.run(tenant, fn)` — opens a tenant context for non-HTTP code | B | | | | | |
| [routing#9] | Returns: underlying `RouteGroup` so you can chain `.prefix()`, `.use()`, `.where()`, etc. | B | | | | | |
| [routing#10] | Example: `router.makeUrl('orders.show', { id }, { prefixUrl: tenant.customDomain \|\| `https://${tenant.id}.app.example.com` })` | B | | | | | |

## configuration.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [config#1] | Key: `backofficeSchemaName` — PG schema holding shared/satellite data | B | | | | | |
| [config#2] | Key: `backofficeConnectionName` — Lucid connection for backoffice schema | B | | | | | |
| [config#3] | Key: `centralSchemaName` — schema for central/global (non-tenant) tables | B | | | | | |
| [config#4] | Key: `centralConnectionName` — Lucid connection for central schema | B | | | | | |
| [config#5] | Key: `tenantConnectionNamePrefix` — prefix for per-tenant connection names | B | | | | | |
| [config#6] | Key: `tenantSchemaPrefix` — prefix for per-tenant schema names | B | | | | | |
| [config#7] | Key: `schemaCacheTtl` — TTL (seconds) for cached schema-existence probes | B | | | | | |
| [config#8] | Key: `ignorePaths` — request paths that skip tenant resolution | B | | | | | |
| [config#9] | Key: `resolverStrategy` — 'subdomain' \| 'header' \| 'path' \| 'domain-or-subdomain' \| 'request-data' | B | | | | | |
| [config#10] | Key: `resolverChain` — ordered resolver names; first hit wins | B | | | | | |
| [config#11] | Key: `tenantHeaderKey` — header name for header resolver | B | | | | | |
| [config#12] | Key: `baseDomain` — apex domain for subdomain parsing | B | | | | | |
| [config#13] | Key: `requestData.queryKey` (default 'tenant_id') | B | | | | | |
| [config#14] | Key: `requestData.bodyKey` (default 'tenant_id') | B | | | | | |
| [config#15] | Key: `isolation.driver` — 'schema-pg' \| 'database-pg' \| 'rowscope-pg' \| 'sqlite-memory' (default 'schema-pg') | B | | | | | |
| [config#16] | Key: `isolation.templateConnectionName` (default 'tenant') — connection cloned per tenant | B | | | | | |
| [config#17] | Key: `isolation.tenantDatabasePrefix` (default 'tenant_') — prefix for database-pg | B | | | | | |
| [config#18] | Key: `isolation.rowScopeTables` — tables wiped on destroy (rowscope-pg) | B | | | | | |
| [config#19] | Key: `isolation.rowScopeColumn` (default 'tenant_id') — column name | B | | | | | |
| [config#20] | Key: `isolation.rowScopeMode` — 'strict' (default) \| 'allowGlobal' | B | | | | | |
| [config#21] | Key: `resilience.defaultPolicy` (default 'fail-closed') — fallback for unspecified dependencies | B | | | | | |
| [config#22] | Key: `resilience.redis.quota` (default 'fail-open') — on Redis outage for QuotaService | B | | | | | |
| [config#23] | Key: `resilience.redis.rateLimit` (default 'fail-closed') — for RateLimitMiddleware | B | | | | | |
| [config#24] | Key: `resilience.redis.cache` (default 'fail-open') — cache bootstrapper | B | | | | | |
| [config#25] | Key: `resilience.redis.metrics` (default 'fail-open') — MetricsService | B | | | | | |
| [config#26] | Key: `resilience.observe` (default true) — emit DependencyDegraded events | B | | | | | |
| [config#27] | Key: `circuitBreaker.threshold` — error-percentage threshold to open | B | | | | | |
| [config#28] | Key: `circuitBreaker.resetTimeout` — ms in OPEN before probing (HALF_OPEN) | B | | | | | |
| [config#29] | Key: `circuitBreaker.rollingCountTimeout` — ms window for rolling error stats | B | | | | | |
| [config#30] | Key: `circuitBreaker.volumeThreshold` — minimum requests before breaker can trip | B | | | | | |
| [config#31] | "Open/closed state is persisted to Redis and restored on restart" | A | | | | | |
| [config#32] | Key: `queue.tenantQueuePrefix` — per-tenant queue-name prefix | B | | | | | |
| [config#33] | Key: `queue.defaultConcurrency` — default worker concurrency | B | | | | | |
| [config#34] | Key: `queue.attempts` — default job retry attempts | B | | | | | |
| [config#35] | Key: `queue.redis` — dedicated Redis for queues | B | | | | | |
| [config#36] | Key: `cache.ttl` — default cache TTL (seconds) | B | | | | | |
| [config#37] | Key: `cache.redis` — dedicated Redis for cache | B | | | | | |
| [config#38] | Key: `backup.storagePath` — local dir for `.dump` archives + sidecar | B | | | | | |
| [config#39] | Key: `backup.metadataTtl` — TTL (seconds) for backup metadata in Redis | B | | | | | |
| [config#40] | Key: `backup.pgConnection` — connection used by pg_dump/pg_restore/psql | B | | | | | |
| [config#41] | Key: `backup.s3` — optional S3 offload config | B | | | | | |
| [config#42] | Key: `plans.defaultPlan` — plan applied when nothing else resolves | B | | | | | |
| [config#43] | Key: `plans.definitions` — Record<string, { limits: Record<string, number> }> | B | | | | | |
| [config#44] | Key: `plans.getPlan` — (tenant) => string \| undefined callback | B | | | | | |
| [config#45] | Key: `plans.storage` — 'config-only' \| 'tenant_plans' \| 'auto' (default 'auto') | B | | | | | |
| [config#46] | Key: `plans.emitTracked` (default false) — emit QuotaTracked on every track/consume | B | | | | | |
| [config#47] | Key: `billing` — BillingConfig for Stripe satellite | B | | | | | |
| [config#48] | Key: `impersonation.secret` — HMAC secret (≥ 32 chars), validated at boot | B | | | | | |
| [config#49] | Key: `impersonation.defaultDuration` (default 3600 seconds) | B | | | | | |
| [config#50] | Key: `impersonation.maxDuration` (default 86400 seconds) | B | | | | | |
| [config#51] | Key: `impersonation.headerName` (default 'x-impersonation-token') | B | | | | | |
| [config#52] | Key: `impersonation.cookieName` (default '__impersonation') | B | | | | | |
| [config#53] | Key: `maintenance.defaultMessage` — default body for TenantMaintenanceException | B | | | | | |
| [config#54] | Key: `maintenance.retryAfterSeconds` (default 600) | B | | | | | |
| [config#55] | Key: `maintenance.bypassToken` / `bypassHeader` (default 'x-tenant-bypass-maintenance') | B | | | | | |
| [config#56] | Key: `softDelete.retentionDays` (default 30) | B | | | | | |
| [config#57] | Key: `doctor.queueStalledMinutes` (default 10) | B | | | | | |
| [config#58] | Key: `doctor.replicaLagWarnSeconds` (default 30) | B | | | | | |
| [config#59] | Key: `doctor.replicaLagErrorSeconds` (default 120) | B | | | | | |
| [config#60] | Key: `doctor.longQueryWarnSeconds` (default 30) | B | | | | | |
| [config#61] | Key: `doctor.longQueryErrorSeconds` (default 120) | B | | | | | |
| [config#62] | Key: `doctor.poolSaturationWarnRatio` (default 0.9) | B | | | | | |
| [config#63] | Key: `tenantReadReplicas.hosts` — pool of read replicas | B | | | | | |
| [config#64] | Key: `tenantReadReplicas.strategy` — 'round-robin' \| 'random' \| 'sticky' (default 'round-robin') | B | | | | | |
| [config#65] | Key: `tenantReadReplicas.connectionSuffix` (default '_read') | B | | | | | |

## models.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [models#1] | Class: `TenantBaseModel` — extends Lucid, lands in active tenant's schema/database | B | | | | | |
| [models#2] | Class: `withTenantScope(BaseModel)` — mixin for rowscope-pg, shared schema + tenant_id filter | B | | | | | |
| [models#3] | Class: `BackofficeBaseModel` — pins `static connection = 'backoffice'` | B | | | | | |
| [models#4] | Class: `CentralBaseModel` — pins `static connection = 'public'` | B | | | | | |
| [models#5] | "TenantBaseModel query with no active tenant context cannot resolve a connection and fails fast" | A | | | | | |
| [models#6] | "Inside an HTTP request the active tenant comes from the guard" | B | | | | | |
| [models#7] | "Outside a request, open a context with tenancy.run(tenant, fn)" | B | | | | | |
| [models#8] | "Injects WHERE tenant_id = <current> on find / fetch / paginate" | B | | | | | |
| [models#9] | "Auto-fills tenant_id on create" | B | | | | | |
| [models#10] | "Throws on update / delete if the row's tenant_id differs from the active scope" | B | | | | | |
| [models#11] | "A top-level orWhere can escape the auto-scope (SQL binds AND tighter than OR)" | A | | | | | |
| [models#12] | "In strict mode (default), a scoped query with no active context throws rather than running unscoped" | B | | | | | |
| [models#13] | "Always reads and writes the shared backoffice schema regardless of active tenant" | B | | | | | |
| [models#14] | "Pins `static connection = 'public'` and prefixes table name with centralSchemaName" | B | | | | | |
| [models#15] | "Lucid relationships cross layers will not resolve (different schemas/databases)" | A | | | | | |
| [models#16] | "Foreign key cannot span per-tenant schema and central schema" | A | | | | | |
| [models#17] | "To associate across layers, store the other layer's id as plain column and load explicitly" | B | | | | | |
| [models#18] | API: `tenancy.run(tenant, fn)` — opens tenant context for jobs, commands, scripts | B | | | | | |
| [models#19] | API: `unscoped(fn)` — disables row-scoping for cross-tenant work | B | | | | | |

## commands.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cmd#1] | Command: `backoffice:setup` — Create backoffice schema and run satellite migrations. Idempotent. | B | | | | | |
| [cmd#2] | Command: `tenant:create <name> <email>` — Insert tenant row and queue InstallTenant | B | | | | | |
| [cmd#3] | Command: `tenant:list` — List tenants with current status. --all includes soft-deleted. | B | | | | | |
| [cmd#4] | Command: `tenant:activate <id>` — Activate a suspended or failed tenant | B | | | | | |
| [cmd#5] | Command: `tenant:suspend <id>` — Block all API access without dropping the schema | B | | | | | |
| [cmd#6] | Command: `tenant:destroy <id>` — Soft-delete and tear down. --force skips prompt; --keep-schema preserves storage during retention | B | | | | | |
| [cmd#7] | Command: `migration:tenant:run` / `tenant:migrate` — Run pending migrations against one or all tenants | B | | | | | |
| [cmd#8] | Flags on tenant:migrate: `--dry-run`, `--disable-locks`, `--verbose` | B | | | | | |
| [cmd#9] | Command: `migration:tenant:rollback` / `tenant:migrate:rollback` — Roll back last migration batch | B | | | | | |
| [cmd#10] | Command: `tenant:migrate:fresh` — DROP and recreate per-tenant storage, then re-run migrations | B | | | | | |
| [cmd#11] | Flags on tenant:migrate:fresh: `--force`, `--seed` | B | | | | | |
| [cmd#12] | Command: `tenant:seed` — db:seed per tenant. --files cherry-picks specific seeders | B | | | | | |
| [cmd#13] | Command: `tenant:backup` — One-shot backup for one or all active tenants (synchronous) | B | | | | | |
| [cmd#14] | Command: `tenant:backups:run` — Cron-friendly: backs up tenants whose tier interval elapsed, then applies retention | B | | | | | |
| [cmd#15] | Flags on tenant:backups:run: `--dry-run`, `--no-retention` | B | | | | | |
| [cmd#16] | Command: `tenant:backup:list` — List available backups | B | | | | | |
| [cmd#17] | Command: `tenant:restore --tenant=<id> --file=<name>` — Restore a tenant schema from .dump file | B | | | | | |
| [cmd#18] | Command: `tenant:import --tenant=<id> --file=<path>` — Import a pg_dump .sql file into a tenant schema | B | | | | | |
| [cmd#19] | Command: `tenant:clone --source=<id> --name=<name> --email=<email>` — Provision new tenant by cloning existing | B | | | | | |
| [cmd#20] | Flags on tenant:clone: `--schema-only`, `--clear-sessions` | B | | | | | |
| [cmd#21] | Command: `tenant:queue:stats` — BullMQ queue statistics | B | | | | | |
| [cmd#22] | Command: `tenant:doctor` — Ten built-in checks, --fix to auto-recover, --json for CI gates, --watch for live TUI | B | | | | | |
| [cmd#23] | Flag: `--tenant=<id>` — Limit to one tenant | B | | | | | |
| [cmd#24] | Flag: `--check=schema_drift,backups` — Run specific checks; --check=list prints available | B | | | | | |
| [cmd#25] | Flag: `--fix` — Auto-fix what's fixable | B | | | | | |
| [cmd#26] | Flag: `--json` — CI gate: exits non-zero if anything is unhealthy | B | | | | | |
| [cmd#27] | Flag: `--watch --interval=5000` — Live dashboard refreshing every 5 s | B | | | | | |
| [cmd#28] | Command: `tenant:exec list:routes` / `tenant:exec --tenant=<id> make:migration users` | B | | | | | |
| [cmd#29] | Flag: `--tenant=<id...>` — Target one or more tenants | B | | | | | |
| [cmd#30] | Flag: `--status=<status...>` — Filter (active, provisioning, suspended, failed, deleted) | B | | | | | |
| [cmd#31] | Flag: `--include-deleted` — Include soft-deleted in iteration | B | | | | | |
| [cmd#32] | Flag: `--limit=<n>` — Stop after N tenants | B | | | | | |
| [cmd#33] | Flag: `--batch-size=<n>` (default 100) — Cursor batch size | B | | | | | |
| [cmd#34] | Flag: `--continue-on-error` — Don't bail on tenant failure | B | | | | | |
| [cmd#35] | Flag: `--dry-run` — Report which tenants would run | B | | | | | |
| [cmd#36] | Command: `tenant:maintenance <id>` — Toggle maintenance mode. --off exits, --message="…" shows custom 503 message | B | | | | | |
| [cmd#37] | Command: `tenant:impersonate <tenantId> <userId>` — Issue admin impersonation token | B | | | | | |
| [cmd#38] | Flags on tenant:impersonate: `--admin=<id>`, `--duration=<seconds>`, `--reason="…"`, `--path=<path>` | B | | | | | |
| [cmd#39] | Command: `tenant:webhooks:retry` — Process pending webhook retries. Cron: `* * * * *` | B | | | | | |
| [cmd#40] | Command: `tenant:metrics:flush` — Flush Redis metric counters to database. Cron: `0 1 * * *` | B | | | | | |
| [cmd#41] | Command: `tenant:purge-expired` — Drop schemas of soft-deleted tenants past retention window. Cron: `0 3 * * *` | B | | | | | |
| [cmd#42] | Command: `tenant:billing:sync` — Reconcile Stripe subscriptions with local mirror | B | | | | | |
| [cmd#43] | Flags on tenant:billing:sync: `--dry-run`, `--tenant=<id>`, `--since=<iso>`, `--json`. Cron: `0 4 * * *` | B | | | | | |
| [cmd#44] | Command: `tenant:billing:backfill` — Seed tenant_plans rows with default plan | B | | | | | |
| [cmd#45] | Flags: `--dry-run`, `--force`, `--plan=<name>` | B | | | | | |
| [cmd#46] | Command: `tenant:billing:replay` — Re-dispatch failed webhook event | B | | | | | |
| [cmd#47] | Flags: `--event-id=<evt>`, `--all-failed` | B | | | | | |
| [cmd#48] | Command: `tenant:billing:cleanup` — Purge stripe_processed_events older than webhook.idempotencyTtlDays | B | | | | | |
| [cmd#49] | Flag: `--batch-size=<n>` | B | | | | | |
| [cmd#50] | Command: `tenant:billing:doctor` — Diagnose Stripe config + recent webhook health | B | | | | | |
| [cmd#51] | Flag: `--json`. Exit 1 on any error. | B | | | | | |
| [cmd#52] | Command: `tenant:billing:test-webhook <event>` — Generate and POST synthetic Stripe event | B | | | | | |
| [cmd#53] | Flags: `--url=<url>`, `--object=<file>` | B | | | | | |
| [cmd#54] | Command: `tenant:repl <tenantId>` — REPL with tenant, db, audit, metrics, and satellite services preloaded | B | | | | | |

## events.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [evt#1] | Event: `TenantCreated` — Payload: `tenant`. Dispatched by tenant:create command, POST /admin/.../tenants | B | | | | | |
| [evt#2] | Event: `TenantProvisioned` — Payload: `tenant`. Dispatched by InstallTenant job | B | | | | | |
| [evt#3] | Event: `TenantActivated` — Payload: `tenant`. Dispatched by tenant:activate command, POST .../activate | B | | | | | |
| [evt#4] | Event: `TenantSuspended` — Payload: `tenant`. Dispatched by tenant:suspend command, POST .../suspend | B | | | | | |
| [evt#5] | Event: `TenantUpdated` — Payload: `tenant`, `changes`. Available for host code; not auto-dispatched | B | | | | | |
| [evt#6] | Event: `TenantMigrated` — Payload: `tenant`, `direction: 'up' \| 'down'`. Dispatched by tenant:migrate and tenant:migrate:rollback | B | | | | | |
| [evt#7] | Event: `TenantBackedUp` — Payload: `tenant`, `metadata: BackupMetadata`. Dispatched by BackupTenant job | B | | | | | |
| [evt#8] | Event: `TenantRestored` — Payload: `tenant`, `fileName`. Dispatched by RestoreTenant job | B | | | | | |
| [evt#9] | Event: `TenantCloned` — Payload: `source`, `destination`, `result: CloneResult`. Dispatched by CloneTenant job | B | | | | | |
| [evt#10] | Event: `TenantQuotaExceeded` — Payload: `tenant`, `quota`, `limit`, `current`, `attempted`. Dispatched by QuotaService.consume() when check rejects | B | | | | | |
| [evt#11] | Event: `QuotaTracked` — Payload: `tenant`, `quota`, `amount`, `total`. Dispatched by QuotaService.track / consume when plans.emitTracked is on | B | | | | | |
| [evt#12] | Event: `TenantEnteredMaintenance` — Payload: `tenant`, `message: string \| null`. Dispatched by tenant:maintenance command, POST .../maintenance | B | | | | | |
| [evt#13] | Event: `TenantExitedMaintenance` — Payload: `tenant`. Dispatched by tenant:maintenance --off, DELETE .../maintenance | B | | | | | |
| [evt#14] | Event: `TenantDeleted` — Payload: `tenant`. Dispatched by tenant:destroy command, UninstallTenant job, DELETE .../tenants/:id | B | | | | | |
| [evt#15] | Event: `SubscriptionActivated` — Payload: `tenantId`, `stripeSubscriptionId`, `planName`. Dispatched by customer.subscription.created (or .updated flipping to active) | B | | | | | |
| [evt#16] | Event: `SubscriptionUpdated` — Payload: `tenantId`, `stripeSubscriptionId`, `previousPlan`, `newPlan`. Dispatched when plan changes | B | | | | | |
| [evt#17] | Event: `SubscriptionCanceled` — Payload: `tenantId`, `stripeSubscriptionId`, `previousPlan`, `reason: 'user_canceled' \| 'dunning_failed' \| 'unknown'`. Dispatched by customer.subscription.deleted | B | | | | | |
| [evt#18] | Event: `SubscriptionPaused` — Payload: `tenantId`, `stripeSubscriptionId`. Dispatched by pause-collection or customer.subscription.paused | B | | | | | |
| [evt#19] | Event: `SubscriptionResumed` — Payload: `tenantId`, `stripeSubscriptionId`. Dispatched by customer.subscription.resumed | B | | | | | |
| [evt#20] | Event: `TrialEnding` — Payload: `tenantId`, `stripeSubscriptionId`, `daysLeft`. Dispatched by customer.subscription.trial_will_end | B | | | | | |
| [evt#21] | Event: `PaymentSucceeded` — Payload: `tenantId`, `invoiceId`, `amount`, `currency`. Dispatched by invoice.payment_succeeded | B | | | | | |
| [evt#22] | Event: `PaymentFailed` — Payload: `tenantId`, `invoiceId`, `amount`, `currency`, `attempts`, `final`, `nextRetry`. Dispatched by invoice.payment_failed (every attempt) | B | | | | | |
| [evt#23] | Event: `BillingMisconfigured` — Payload: `stripeSubscriptionId`, `productId`, `priceId`. Dispatched when Stripe product/price has no mapping in config.billing.products | B | | | | | |
| [evt#24] | Event: `BillingEventDeadLettered` — Payload: `eventId`, `errorCode`, `details`. Dispatched when webhook event exhausted all queue retries | B | | | | | |
| [evt#25] | Event: `DependencyDegraded` — Payload: `dependency`, `operation`, `tenantId`, `policy`, `errorCode`. Dispatched by ResilienceService when call fails | B | | | | | |
| [evt#26] | API: `emitter.on(EventClass, listener)` — standard AdonisJS emitter API | B | | | | | |
| [evt#27] | API: `EventClass.dispatch(...args)` — static helper for dispatching | B | | | | | |
| [evt#28] | "emitter.emit() runs every listener in parallel" | A | | | | | |
| [evt#29] | "If a listener throws, the rejection propagates but sibling listeners still run" | B | | | | | |

## hooks.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [hooks#1] | Event: `provision` — Fires around tenant schema/database creation. Context: `{ tenant }` | B | | | | | |
| [hooks#2] | Event: `destroy` — Fires around tenant teardown. Context: `{ tenant }` | B | | | | | |
| [hooks#3] | Event: `migrate` — Fires around per-tenant migrations. Context: `{ tenant, direction: 'up' \| 'down' }` | B | | | | | |
| [hooks#4] | Event: `backup` — Fires around tenant backup. Context: `{ tenant, metadata? }` | B | | | | | |
| [hooks#5] | Event: `restore` — Fires around tenant restore. Context: `{ tenant, fileName }` | B | | | | | |
| [hooks#6] | Event: `clone` — Fires around tenant clone. Context: `{ source, destination, result? }` | B | | | | | |
| [hooks#7] | Phase: `before` — thrown error aborts the operation | B | | | | | |
| [hooks#8] | Phase: `after` — thrown error is logged and swallowed | B | | | | | |
| [hooks#9] | Config key: `hooks.beforeProvision` — async ({ tenant }) => { } | B | | | | | |
| [hooks#10] | Config key: `hooks.afterProvision` — async ({ tenant }) => { } | B | | | | | |
| [hooks#11] | Config key: `hooks.beforeDestroy` — async ({ tenant }) => { } | B | | | | | |
| [hooks#12] | Config key: `hooks.afterDestroy` — async ({ tenant }) => { } | B | | | | | |
| [hooks#13] | Config key: `hooks.beforeMigrate` — async ({ tenant, direction }) => { } | B | | | | | |
| [hooks#14] | Config key: `hooks.afterMigrate` — async ({ tenant, direction }) => { } | B | | | | | |
| [hooks#15] | Config key: `hooks.beforeBackup` — async ({ tenant, metadata? }) => { } | B | | | | | |
| [hooks#16] | Config key: `hooks.afterBackup` — async ({ tenant, metadata? }) => { } | B | | | | | |
| [hooks#17] | Config key: `hooks.beforeRestore` — async ({ tenant, fileName }) => { } | B | | | | | |
| [hooks#18] | Config key: `hooks.afterRestore` — async ({ tenant, fileName }) => { } | B | | | | | |
| [hooks#19] | Config key: `hooks.beforeClone` — async ({ source, destination, result? }) => { } | B | | | | | |
| [hooks#20] | Config key: `hooks.afterClone` — async ({ source, destination, result? }) => { } | B | | | | | |
| [hooks#21] | API: `HookRegistry.before(event, fn)` / `.after(event, fn)` — chainable API | B | | | | | |
| [hooks#22] | API: Resolve from container: `app.container.make(HookRegistry)` | B | | | | | |

## services.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [svc#1] | Method: `consume(tenant, quota, amount = 1) → Promise<number>` — Atomically increments; throws QuotaExceededException on overrun. Returns new usage. | B | | | | | |
| [svc#2] | Method: `track(tenant, quota, amount = 1) → Promise<number>` — Increments without enforcing limit | B | | | | | |
| [svc#3] | Method: `check(tenant, quota, amount?) → Promise<QuotaCheckResult>` — Non-mutating check | B | | | | | |
| [svc#4] | Method: `getUsage(tenant, quota) → Promise<number>` — Current usage | B | | | | | |
| [svc#5] | Method: `setUsage(tenant, quota, value) → Promise<void>` — Overwrite counter | B | | | | | |
| [svc#6] | Method: `reset(tenant, quota?) → Promise<void>` — Reset one quota or all | B | | | | | |
| [svc#7] | Method: `getLimit(tenant, quota) → Promise<number>` — Resolved plan's limit | B | | | | | |
| [svc#8] | Method: `getPlanFor(tenant) → Promise<{ name, plan }>` — Tenant's resolved plan | B | | | | | |
| [svc#9] | Method: `assignPlan(tenant, plan, ...) → Promise<…>` — Persist plan assignment | B | | | | | |
| [svc#10] | Method: `getAssignedPlan(tenantId)` / `clearAssignedPlan(tenantId)` — Read/clear stored assignment | B | | | | | |
| [svc#11] | Method: `snapshot(tenant) → Promise<QuotaStateSnapshot>` — All quotas + usage at once | B | | | | | |
| [svc#12] | "Redis-dependent calls route through ResilienceService" | A | | | | | |
| [svc#13] | Method: `log({ action, tenantId?, actorType?, actorId?, metadata?, ipAddress? }) → Promise<TenantAuditLog>` | B | | | | | |
| [svc#14] | Method: `listForTenant(tenantId, page = 1, limit = 50, { from?, to? } = {}) → Promise<…>` (limit capped at 200) | B | | | | | |
| [svc#15] | Method: `dispatch(tenantId, event, payload) → Promise<void>` — Fan out to subscribed hooks | B | | | | | |
| [svc#16] | Method: `registerWebhook(tenantId, url, events, secret?) → Promise<TenantWebhook>` — Validates URL against SSRF guard | B | | | | | |
| [svc#17] | Method: `listWebhooks(tenantId)` / `deleteWebhook(id, tenantId)` → Promise<TenantWebhook[]> / Promise<void> | B | | | | | |
| [svc#18] | Method: `processRetries() → Promise<void>` — Send deliveries whose next_retry_at is due | B | | | | | |
| [svc#19] | Export: `verifyWebhookSignature(rawBody, signatureHeader, secret): boolean` — constant-time check | B | | | | | |
| [svc#20] | Method: `getForTenant(tenantId) → Promise<TenantBranding \| null>` (cached 300s) | B | | | | | |
| [svc#21] | Method: `upsert(tenantId, data: BrandingData) → Promise<TenantBranding>` (busts cache) | B | | | | | |
| [svc#22] | Method: `renderEmailContext(branding)` — plain object with email fields + sane fallbacks | B | | | | | |
| [svc#23] | Method: `isEnabled(tenantId, flag) → Promise<boolean>` (false when absent; cached 60s) | B | | | | | |
| [svc#24] | Method: `set(tenantId, flag, enabled, config?) → Promise<TenantFeatureFlag>` (upsert) | B | | | | | |
| [svc#25] | Method: `listForTenant(tenantId)` / `delete(tenantId, flag)` → Promise<TenantFeatureFlag[]> / Promise<void> | B | | | | | |
| [svc#26] | Method: `increment(tenantId, 'requests' \| 'errors', amount = 1) → Promise<void>` | B | | | | | |
| [svc#27] | Method: `trackBandwidth(tenantId, bytes) → Promise<void>` | B | | | | | |
| [svc#28] | Method: `flush(period?) → Promise<void>` — Rolls Redis counters into tenant_metrics | B | | | | | |
| [svc#29] | Method: `getForTenant(tenantId, days = 30) → Promise<TenantMetric[]>` | B | | | | | |

## exceptions.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [exc#1] | Exception: `MissingTenantHeaderException` — Status: 400, Code: `E_MISSING_TENANT_HEADER`, Thrown when no tenant id can be resolved | B | | | | | |
| [exc#2] | Exception: `TenantHeaderDomainMismatchException` — Status: 400, Code: `E_TENANT_HEADER_DOMAIN_MISMATCH`, Possible hijack attempt | B | | | | | |
| [exc#3] | Exception: `TenantNotFoundException` — Status: 404, Code: `E_TENANT_NOT_FOUND`, Resolved tenant id doesn't exist | B | | | | | |
| [exc#4] | Exception: `CentralRouteViolationException` — Status: 404, Code: `E_CENTRAL_ROUTE_VIOLATION`, Central-only route reached in tenant context (or vice-versa) | B | | | | | |
| [exc#5] | Exception: `TenantSuspendedException` — Status: 403, Code: `E_TENANT_SUSPENDED`, Tenant is suspended | B | | | | | |
| [exc#6] | Exception: `TenantNotReadyException` — Status: 503, Code: `E_TENANT_NOT_READY`, Tenant still provisioning | B | | | | | |
| [exc#7] | Exception: `TenantMaintenanceException` — Status: 503, Code: `E_TENANT_MAINTENANCE`, Tenant in maintenance mode. Carries retryAfterSeconds. | B | | | | | |
| [exc#8] | Exception: `CircuitOpenException` — Status: 503, Code: `E_CIRCUIT_OPEN`, Tenant DB circuit breaker is OPEN | B | | | | | |
| [exc#9] | Exception: `RateLimitUnavailableException` — Status: 503, Code: `E_RATE_LIMIT_UNAVAILABLE`, Rate-limit backend (Redis) errored and route is fail-closed | B | | | | | |
| [exc#10] | Exception: `DependencyUnavailableException` — Status: 503, Code: `E_DEPENDENCY_UNAVAILABLE`, fail-closed dependency errored. Carries dependency, operation, tenantId. | B | | | | | |
| [exc#11] | Exception: `TooManyRequestsException` — Status: 429, Code: `E_TOO_MANY_REQUESTS`, Exceeded RateLimitMiddleware window. Sets Retry-After. | B | | | | | |
| [exc#12] | Exception: `QuotaExceededException` — Status: 429, Code: `E_TENANT_QUOTA_EXCEEDED`, QuotaService.consume() would exceed limit. Carries quota, limit, current, attempted. | B | | | | | |
| [exc#13] | Exception: `BillingException` — Status: 400, Code: `E_BILLING`, Stripe/billing error. Carries billingCode and isRetryable() | B | | | | | |

## data-isolation/index.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [iso#1] | Driver: `schema-pg` — One PG schema per tenant. Default. Strongest balance of isolation and operational cost. | B | | | | | |
| [iso#2] | Driver: `database-pg` — One PG database per tenant. Requires CREATEDB. Best for OS-level isolation. | B | | | | | |
| [iso#3] | Driver: `rowscope-pg` — Shared schema + tenant_id column. Best for lightweight workloads, large tenant counts. | B | | | | | |
| [iso#4] | Driver: `sqlite-memory` — In-process SQLite per tenant. Tests only. | B | | | | | |
| [iso#5] | Method: `provision` — Create the tenant's storage (schema/database/rows) | B | | | | | |
| [iso#6] | Method: `destroy` — Drop it cleanly (terminates active sessions first) | B | | | | | |
| [iso#7] | Method: `reset` — Drop and recreate (used by tenant:migrate:fresh) | B | | | | | |
| [iso#8] | Method: `connect` — Open the runtime Lucid connection | B | | | | | |
| [iso#9] | Method: `disconnect` — Close it | B | | | | | |
| [iso#10] | Method: `connectionName` — Synchronous resolver for the active query's connection | B | | | | | |
| [iso#11] | Method: `migrate` — Run migrations against this tenant's storage | B | | | | | |

## data-isolation/schema-pg.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [schema#1] | "Each tenant lives in its own schema named `tenant_<uuid>` on a shared database" | B | | | | | |
| [schema#2] | "Lucid connections are named `tenant_<uuid>` as well" | B | | | | | |
| [schema#3] | Step: "Validate the tenant id with `assertSafeIdentifier` — [a-zA-Z0-9_-]{1,63}" | B | | | | | |
| [schema#4] | Step: "CREATE SCHEMA \"tenant_<uuid>\" on the shared template connection" | B | | | | | |
| [schema#5] | Step: "Register a Lucid connection tenant_<uuid> with searchPath: tenant_<uuid>" | B | | | | | |
| [schema#6] | Step: "Run per-tenant migrations" | B | | | | | |
| [schema#7] | Step: "Mark tenant as deleted_at (soft delete)" | B | | | | | |
| [schema#8] | Step: "After retention window: pg_terminate_backend against any sessions on the schema" | B | | | | | |
| [schema#9] | Step: "DROP SCHEMA \"tenant_<uuid>\" CASCADE" | B | | | | | |
| [schema#10] | Step: "Close and unregister the Lucid connection" | B | | | | | |
| [schema#11] | Config: `isolation: { driver: 'schema-pg', templateConnectionName: 'tenant' }` | B | | | | | |
| [schema#12] | "pg_dump --schema=tenant_<uuid> produces a portable per-tenant archive" | B | | | | | |
| [schema#13] | "Schemas don't share connection pools by default; they share the template connection's pool" | B | | | | | |
| [schema#14] | "Migrations are tracked per schema using a per-tenant Lucid migrations table" | B | | | | | |

## data-isolation/database-pg.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [database#1] | "Each tenant gets its own PostgreSQL database named `tenant_<uuid>` (configurable via tenantDatabasePrefix)" | B | | | | | |
| [database#2] | "Connections are independent; nothing is shared at the database level" | B | | | | | |
| [database#3] | "Lucid template connection role must have the CREATEDB privilege" | A | | | | | |
| [database#4] | "CREATE DATABASE cannot run inside a transaction. The driver runs it outside one" | A | | | | | |
| [database#5] | "destroy calls pg_terminate_backend on every active session before issuing DROP DATABASE" | A | | | | | |
| [database#6] | Config: `isolation: { driver: 'database-pg', tenantDatabasePrefix: 'tenant_', templateConnectionName: 'tenant' }` | B | | | | | |
| [database#7] | Step: "Validate the tenant id (assertSafeIdentifier)" | B | | | | | |
| [database#8] | Step: "CREATE DATABASE \"tenant_<uuid>\" on the template connection (no transaction)" | B | | | | | |
| [database#9] | Step: "Register a per-tenant Lucid connection pointed at the new database" | B | | | | | |
| [database#10] | Step: "Run migrations against it" | B | | | | | |
| [database#11] | Step: "pg_terminate_backend on every backend with datname = 'tenant_<uuid>'" | B | | | | | |
| [database#12] | Step: "DROP DATABASE IF EXISTS \"tenant_<uuid>\"" | B | | | | | |
| [database#13] | Step: "Close and unregister the Lucid connection" | B | | | | | |
| [database#14] | Pro: "Per-tenant credentials and roles" | B | | | | | |
| [database#15] | Pro: "Tenant data lives in different files / WAL" | B | | | | | |
| [database#16] | Pro: "Easy to replicate or relocate one tenant" | B | | | | | |
| [database#17] | Pro: "pg_dump per tenant is a single-database dump" | B | | | | | |
| [database#18] | Con: "Separate connection pool per tenant; costlier" | B | | | | | |
| [database#19] | Con: "Can't JOIN across tenants for reporting" | B | | | | | |
| [database#20] | Con: "Migrations run N times instead of once" | B | | | | | |
| [database#21] | Con: "Tenant counts in the thousands strain the connection budget" | B | | | | | |

## data-isolation/rowscope-pg.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [rowscope#1] | "Every tenant-scoped table includes a `tenant_id` column (configurable via rowScopeColumn)" | B | | | | | |
| [rowscope#2] | "Models opt in via the `withTenantScope` mixin" | B | | | | | |
| [rowscope#3] | "Injects WHERE tenant_id = <current> on find / fetch / paginate" | B | | | | | |
| [rowscope#4] | "Auto-fills tenant_id on create" | B | | | | | |
| [rowscope#5] | "Throws on update / delete if the row's tenant_id differs from the active scope" | B | | | | | |
| [rowscope#6] | "A query outside both tenancy.run() and unscoped() throws MissingTenantScopeException instead of returning rows from every tenant" | A | | | | | |
| [rowscope#7] | "This catches forgotten context in jobs, scripts, and tests" | B | | | | | |
| [rowscope#8] | Config: `isolation: { driver: 'rowscope-pg', rowScopeColumn: 'tenant_id', rowScopeTables: [...], rowScopeMode: 'strict' }` | B | | | | | |
| [rowscope#9] | "rowscope-pg has no per-tenant connection: every tenant shares your centralConnectionName" | B | | | | | |
| [rowscope#10] | "You do NOT set templateConnectionName for rowscope-pg" | B | | | | | |
| [rowscope#11] | "A top-level orWhere can escape the auto-scope — SQL binds AND tighter than OR" | A | | | | | |
| [rowscope#12] | "Always wrap OR branches in a group so the tenant predicate covers all of them" | A | | | | | |
| [rowscope#13] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=rls` | A | | | | | |
| [rowscope#14] | "Publishes migration *_enable_rls_tenant_isolation.ts" | A | | | | | |
| [rowscope#15] | "For each table: ALTER TABLE ENABLE ROW LEVEL SECURITY; ALTER TABLE FORCE ROW LEVEL SECURITY" | A | | | | | |
| [rowscope#16] | "Creates a fail-closed policy: USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))" | A | | | | | |
| [rowscope#17] | "When app.tenant_id is unset, nullif(...) makes the predicate NULL, so it matches nothing and WITH CHECK blocks the insert" | A | | | | | |
| [rowscope#18] | API: `withTenantRls(tenant.id, async (trx) => { ... })` — opens a transaction, sets the GUC, hands you the trx | A | | | | | |
| [rowscope#19] | "withTenantRls does NOT open a tenancy.run() scope" | A | | | | | |
| [rowscope#20] | "Run your app without SUPERUSER / BYPASSRLS" | A | | | | | |
| [rowscope#21] | "destroy(tenant) runs DELETE FROM <table> WHERE tenant_id = ? for every table in rowScopeTables" | B | | | | | |
| [rowscope#22] | "There is no DROP SCHEMA / DROP DATABASE" | B | | | | | |
| [rowscope#23] | Pro: "Single connection pool; scales to 100k+ tenants" | B | | | | | |
| [rowscope#24] | Pro: "Reporting is trivial" | B | | | | | |
| [rowscope#25] | Pro: "Migrations run once for the whole app" | B | | | | | |
| [rowscope#26] | Pro: "unscoped() makes admin work explicit" | B | | | | | |
| [rowscope#27] | Con: "One missing scope leaks across tenants" | B | | | | | |
| [rowscope#28] | Con: "Bigger indexes; tenant_id is in every key" | B | | | | | |
| [rowscope#29] | Con: "You own the discipline of always wrapping with tenancy.run()" | B | | | | | |
| [rowscope#30] | Con: "Backups are not per-tenant by default" | B | | | | | |

## data-isolation/sqlite-memory.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [sqlite#1] | "This driver writes to :memory:. Data does not survive a process exit. Never enable it in production." | A | | | | | |
| [sqlite#2] | "Each tenant gets an in-process SQLite database for the life of the process" | B | | | | | |
| [sqlite#3] | Config: `isolation: { driver: 'sqlite-memory' }` (test environment only) | B | | | | | |
| [sqlite#4] | "No JSONB, no array columns, no PG-specific extensions" | B | | | | | |
| [sqlite#5] | "Migrations need to be SQLite-compatible" | B | | | | | |
| [sqlite#6] | "Concurrency story is single-writer" | B | | | | | |
| [sqlite#7] | "Unit tests that exercise tenant-scoped model logic without needing a real Postgres" | B | | | | | |
| [sqlite#8] | "Documentation snippets you want to run as test fixtures" | B | | | | | |
| [sqlite#9] | "Quick CI smoke runs" | B | | | | | |

## bootstrappers/index.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [bootstrap#1] | "A bootstrapper is a per-service hook that enters when tenant context activates, leaves when it ends" | B | | | | | |
| [bootstrap#2] | "tenancy.run(tenant, fn) activates the bootstrapper registry around fn" | B | | | | | |
| [bootstrap#3] | "Each registered bootstrapper sees enter(ctx) before fn runs and leave(ctx) after, even on fn throw" | B | | | | | |
| [bootstrap#4] | Bootstrapper: `cacheBootstrapper` — BentoCache — Namespaces every key by `tenants/<id>/…` | B | | | | | |
| [bootstrap#5] | Bootstrapper: `driveBootstrapper` — @adonisjs/drive — Prefixes every operation with `tenants/<id>/` | B | | | | | |
| [bootstrap#6] | Bootstrapper: `mailBootstrapper` — @adonisjs/mail — Switches SMTP credentials and from address per tenant | B | | | | | |
| [bootstrap#7] | Bootstrapper: `sessionBootstrapper` — @adonisjs/session — Prefixes session keys with tenant id | B | | | | | |
| [bootstrap#8] | Bootstrapper: `transmitBootstrapper` — @adonisjs/transmit — Scopes broadcast channels per tenant | B | | | | | |
| [bootstrap#9] | "Database is not a bootstrapper — query routing is handled inside TenantAdapter via the active IsolationDriver" | A | | | | | |
| [bootstrap#10] | "Bootstrappers are auto-registered when the corresponding service binding is present" | B | | | | | |
| [bootstrap#11] | "The package probes container.hasBinding(...) for each candidate" | B | | | | | |
| [bootstrap#12] | "The cache bootstrapper is always registered — the package treats it as a hard requirement" | B | | | | | |
| [bootstrap#13] | API: `registry.unregister('drive')` — skip even though @adonisjs/drive is installed | B | | | | | |
| [bootstrap#14] | Default order: cache (1), drive (2), mail (3), session (4), transmit (5) | B | | | | | |
| [bootstrap#15] | "Registry enters in ascending order and leaves in descending order, exactly like a stack" | B | | | | | |
| [bootstrap#16] | Interface: `Bootstrapper` with `priority` property and `async enter(ctx)` / `async leave(ctx)` | B | | | | | |
| [bootstrap#17] | Invariant: "leave runs even if enter or fn throw" | B | | | | | |
| [bootstrap#18] | Invariant: "A failure in one enter aborts the rest and unwinds prior successful enters in reverse order" | B | | | | | |

## bootstrappers/database.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [db-bootstrap#1] | "Database routing is handled inside TenantAdapter via the active IsolationDriver" | B | | | | | |
| [db-bootstrap#2] | "It runs synchronously per query, before any bootstrapper code fires" | B | | | | | |
| [db-bootstrap#3] | "TenantAdapter.modelConstructorClient() is called by Lucid every time a TenantBaseModel query starts" | B | | | | | |
| [db-bootstrap#4] | "The adapter reads the active tenant via tenancy.currentId() (or HttpContext.tenant)" | B | | | | | |
| [db-bootstrap#5] | "The adapter asks the active IsolationDriver for the connection name" | B | | | | | |
| [db-bootstrap#6] | "Returns the connection so the query routes there" | B | | | | | |
| [db-bootstrap#7] | "Bootstrappers run on the enter / leave cycle of a tenant context" | B | | | | | |
| [db-bootstrap#8] | "Database routing happens per query, not per context" | B | | | | | |
| [db-bootstrap#9] | "Adapter calls are synchronous, frequent, and work even for code paths that never call tenancy.run()" | B | | | | | |
| [db-bootstrap#10] | "If no driver matches the configured isolation.driver, the adapter throws on the first query with the driver name in the message" | B | | | | | |

## bootstrappers/cache.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cache-bootstrap#1] | "The package ships a single shared BentoCache instance — memory L1, Redis L2, and a Redis bus for cross-process invalidation" | B | | | | | |
| [cache-bootstrap#2] | "A helper that returns a namespace prefixed by the tenant id" | B | | | | | |
| [cache-bootstrap#3] | Function: `cacheFor(tenant)` — namespace: tenant:<id> | B | | | | | |
| [cache-bootstrap#4] | "Accepts either a tenant model (any object with .id) or a raw id string" | B | | | | | |
| [cache-bootstrap#5] | "The id is run through assertSafeIdentifier before namespace is built" | B | | | | | |
| [cache-bootstrap#6] | Function: `getCache()` — the unprefixed shared instance for cross-tenant data | B | | | | | |
| [cache-bootstrap#7] | "For cross-tenant data — feature-flag definitions, plan catalogs, anything global" | B | | | | | |
| [cache-bootstrap#8] | Layer: L1 — in-process memory (5 MB cap) — sub-microsecond reads | B | | | | | |
| [cache-bootstrap#9] | Layer: L2 — Redis (`config.cache.redis`) — shared across processes | B | | | | | |
| [cache-bootstrap#10] | Layer: Bus — Redis pub/sub — a delete on one process invalidates L1 on others | B | | | | | |
| [cache-bootstrap#11] | Config: `cache: { ttl: 300, redis: { host, port, db: 2 } }` | B | | | | | |
| [cache-bootstrap#12] | "cacheFor() always validates the id against /^[a-zA-Z0-9_-]{1,63}$/" | A | | | | | |
| [cache-bootstrap#13] | "Crafted ids — path traversal, embedded colons, newlines, anything that could collide with another tenant's prefix — are rejected synchronously" | B | | | | | |

## bootstrappers/filesystem.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [fs-bootstrap#1] | "Auto-detected when @adonisjs/drive is installed" | B | | | | | |
| [fs-bootstrap#2] | "Prefixes every filesystem operation with `tenants/<tenant.id>/`" | B | | | | | |
| [fs-bootstrap#3] | "Applies to every disk you've configured (local, s3, gcs, …)" | B | | | | | |
| [fs-bootstrap#4] | "drive.list() returns paths relative to the tenant prefix by default" | B | | | | | |
| [fs-bootstrap#5] | "Pass { raw: true } to read the global path" | B | | | | | |
| [fs-bootstrap#6] | "URL signing respects the prefix automatically" | B | | | | | |
| [fs-bootstrap#7] | Config: `drive: { enabled: true, prefix: 'tenants/{id}/' }` | B | | | | | |
| [fs-bootstrap#8] | "The drive bootstrapper does NOT automatically delete a tenant's files when the tenant is destroyed" | B | | | | | |
| [fs-bootstrap#9] | "Wire that up via a hook or event listener" | B | | | | | |

## bootstrappers/mail.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [mail-bootstrap#1] | "Auto-detected when @adonisjs/mail is installed" | B | | | | | |
| [mail-bootstrap#2] | "For the duration of the tenant context, mail.send(...) resolves SMTP credentials and the from address from the tenant's branding record (or any row source you configure)" | B | | | | | |
| [mail-bootstrap#3] | Config: `mail: { enabled: true, resolver: async (tenant) => { ... } }` | B | | | | | |
| [mail-bootstrap#4] | "The resolver returns { from, smtp: {...} \| null }" | B | | | | | |
| [mail-bootstrap#5] | "smtp: null means use the default mailer" | B | | | | | |
| [mail-bootstrap#6] | "When tenants store SMTP passwords, they belong in tenant_brandings with the encrypted column treatment" | B | | | | | |
| [mail-bootstrap#7] | "The BrandingService handles encrypt-on-write / decrypt-on-read" | B | | | | | |
| [mail-bootstrap#8] | "Setting from per tenant changes the DKIM signing domain that your provider uses" | A | | | | | |
| [mail-bootstrap#9] | "Ensure each domain has the right DKIM record published; otherwise emails land in spam" | B | | | | | |

## bootstrappers/session.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [session-bootstrap#1] | "Auto-detected when @adonisjs/session is installed" | B | | | | | |
| [session-bootstrap#2] | "Prefixes every session read and write so two tenants on the same host cannot collide on a session key" | B | | | | | |
| [session-bootstrap#3] | Example: session.put('cart', cart) → actual key is `tenants/<active-tenant-id>/cart` | B | | | | | |
| [session-bootstrap#4] | "If you're using subdomain-based routing (acme.app.example.com, globex.app.example.com), browsers already partition cookies by host" | B | | | | | |
| [session-bootstrap#5] | Config to disable: `bootstrappers: { session: false }` | B | | | | | |
| [session-bootstrap#6] | "Path-based routing (/<uuid>/...) on a single origin shares cookies across all tenants" | B | | | | | |
| [session-bootstrap#7] | Config: `session: { enabled: true, prefix: 't:{id}:' }` | B | | | | | |

## bootstrappers/broadcasting.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [broadcast-bootstrap#1] | "Auto-detected when @adonisjs/transmit is installed" | B | | | | | |
| [broadcast-bootstrap#2] | "Every transmit.broadcast(...) and transmit.subscribe(...) is silently rewritten to a tenant-local channel" | B | | | | | |
| [broadcast-bootstrap#3] | Example: transmit.broadcast('orders/123', {...}) → actual channel is `tenants/<active-tenant-id>/orders/123` | B | | | | | |
| [broadcast-bootstrap#4] | "Without scoping, two tenants sharing the same Transmit/SSE backend would receive each other's broadcasts" | A | | | | | |
| [broadcast-bootstrap#5] | "The bootstrapper makes the mistake structurally impossible" | B | | | | | |
| [broadcast-bootstrap#6] | Config: `transmit: { enabled: true, prefix: 'tenants/{id}/' }` | B | | | | | |
| [broadcast-bootstrap#7] | "The bootstrapper handles channel naming. Authorization is still your job." | B | | | | | |
| [broadcast-bootstrap#8] | "Use Transmit's channel.authorize() callbacks; the channel name is already tenant-prefixed" | B | | | | | |

## satellites/index.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [sat#1] | "Nine opt-in features attached to tenants" | B | | | | | |
| [sat#2] | "None of these are required to run Lasagna" | A | | | | | |
| [sat#3] | "Each ships its own backoffice migration, its own service, and its own admin endpoint" | B | | | | | |
| [sat#4] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks` | B | | | | | |
| [sat#5] | "The configure command is idempotent" | B | | | | | |
| [sat#6] | Satellite: Audit — Structured audit trail with actor + payload — Storage: tenant_audit_logs | B | | | | | |
| [sat#7] | Satellite: Feature flags — Per-tenant boolean flags (kill switches, beta cohorts), cached — Storage: tenant_feature_flags | B | | | | | |
| [sat#8] | Satellite: Webhooks — HMAC-signed outbound events with delivery state machine and retries — Storage: tenant_webhooks, tenant_webhook_deliveries | B | | | | | |
| [sat#9] | Satellite: Branding — Per-tenant logo, colors, custom domain, encrypted SMTP — Storage: tenant_brandings | B | | | | | |
| [sat#10] | Satellite: SSO — Per-tenant OIDC config with JWKS-backed verification — Storage: tenant_sso_configs | B | | | | | |
| [sat#11] | Satellite: Metrics — Time-series counters per tenant with cursor-based aggregation — Storage: tenant_metrics | B | | | | | |
| [sat#12] | Satellite: Quotas — Plan-bound limits; rolling and snapshot — Storage: tenant_quotas, tenant_plans | B | | | | | |
| [sat#13] | Satellite: Billing — Stripe integration — Storage: stripe_customers, stripe_subscriptions, stripe_processed_events, stripe_meter_events | B | | | | | |
| [sat#14] | Satellite: Impersonation — Admin enters a tenant as a target user, time-boxed and audited — Storage: Redis (no DB row) | B | | | | | |
| [sat#15] | "Every satellite that writes to a database table goes through the backoffice schema; never the per-tenant schema" | B | | | | | |
| [sat#16] | "Every satellite that mutates state writes an audit row when the audit satellite is enabled" | B | | | | | |
| [sat#17] | "Satellites never call each other directly; they go through their respective service contracts" | B | | | | | |

## satellites/audit.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [audit#1] | "Tenant lifecycle (created, activated, suspended, soft_deleted, restored, purged)" | B | | | | | |
| [audit#2] | "Webhook subscription / delivery state changes" | B | | | | | |
| [audit#3] | "Branding updates (with encrypted fields redacted)" | B | | | | | |
| [audit#4] | "SSO config updates" | B | | | | | |
| [audit#5] | "Impersonation grants and revocations" | B | | | | | |
| [audit#6] | "Quota threshold breaches" | B | | | | | |
| [audit#7] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=audit` | B | | | | | |
| [audit#8] | "The migration creates tenant_audit_logs in the backoffice schema" | B | | | | | |
| [audit#9] | "Migration installs three PostgreSQL triggers — BEFORE UPDATE, BEFORE DELETE, BEFORE TRUNCATE — that all RAISE EXCEPTION" | B | | | | | |
| [audit#10] | "Audit rows are append-only at the database level" | A | | | | | |
| [audit#11] | Method: `audit.log({ tenantId, actorType, actorId, action, metadata, ipAddress })` | B | | | | | |
| [audit#12] | Column: id, tenant_id, actor_type, actor_id, action, metadata, ip_address, created_at | B | | | | | |
| [audit#13] | Index: (tenant_id, created_at) | B | | | | | |
| [audit#14] | REST: `GET /admin/multitenancy/tenants/<id>/audit-logs?from=2026-04-01&to=2026-04-30` | B | | | | | |
| [audit#15] | "from and to parameters expect ISO 8601 dates" | B | | | | | |
| [audit#16] | "No OFFSET cost regardless of how many rows the tenant has" | B | | | | | |
| [audit#17] | "You can't DELETE FROM tenant_audit_logs directly — the trigger will reject it" | A | | | | | |
| [audit#18] | Pattern 1: "Ship to a long-term store, then purge under controlled access — a privileged retention job temporarily disables the delete trigger" | B | | | | | |
| [audit#19] | Pattern 2: "Partition by month and DETACH + DROP old partitions — DROP TABLE doesn't fire the row-level triggers" | B | | | | | |

## satellites/feature-flags.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [flags#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=feature_flags` | B | | | | | |
| [flags#2] | Method: `isEnabled(tenantId, flag) → Promise<boolean>` (false when absent) | B | | | | | |
| [flags#3] | Method: `set(tenantId, flag, enabled, config?) → Promise<TenantFeatureFlag>` (upsert) | B | | | | | |
| [flags#4] | Method: `listForTenant(tenantId)` / `delete(tenantId, flag)` | B | | | | | |
| [flags#5] | Column: id (UUID v4), tenant_id, flag, enabled (boolean), config (optional JSON), created_at, updated_at | B | | | | | |
| [flags#6] | "isEnabled reads through a per-tenant cache: whole flag map cached under ff_map:<tenantId> for 60s" | B | | | | | |
| [flags#7] | "set/delete bust the cache" | B | | | | | |
| [flags#8] | REST: GET /admin/multitenancy/tenants/{id}/feature-flags | B | | | | | |
| [flags#9] | REST: PUT /admin/multitenancy/tenants/{id}/feature-flags/{key} | B | | | | | |
| [flags#10] | REST: DELETE /admin/multitenancy/tenants/{id}/feature-flags/{key} | B | | | | | |
| [flags#11] | "Evaluation is a boolean kill switch — no built-in percentage rollout" | B | | | | | |
| [flags#12] | "Flags are cached for 60s, so a set takes up to a minute to propagate" | B | | | | | |

## satellites/webhooks.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [webhook#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=webhooks` | B | | | | | |
| [webhook#2] | Method: `subscribe({ tenantId, events, url, secret? })` | B | | | | | |
| [webhook#3] | "Generated when omitted; encrypted at rest with APP_KEY (AES-256-GCM)" | B | | | | | |
| [webhook#4] | Method: `dispatch({ tenantId, event, payload })` | B | | | | | |
| [webhook#5] | Header: `content-type: application/json` | B | | | | | |
| [webhook#6] | Header: `x-webhook-signature: <hex>` — HMAC-SHA256 over the raw body | B | | | | | |
| [webhook#7] | Header: `x-webhook-event: <event>` | B | | | | | |
| [webhook#8] | Header: `x-delivery-id: <uuid>` | B | | | | | |
| [webhook#9] | Export: `verifyWebhookSignature(rawBody, signature, secret): boolean` | B | | | | | |
| [webhook#10] | "Use constant-time helper; naive === comparisons leak timing" | A | | | | | |
| [webhook#11] | "Pass the EXACT bytes received — not re-serialized JSON" | A | | | | | |
| [webhook#12] | "To defeat replay, log x-delivery-id and reject duplicates within a small TTL window" | B | | | | | |
| [webhook#13] | State: pending → delivering → delivered (2xx) or failed (non-2xx) | B | | | | | |
| [webhook#14] | State: failed → retry_scheduled (if retries left) or permanently_failed (no retries) | B | | | | | |
| [webhook#15] | State: retry_scheduled → delivering (after backoff elapsed) | B | | | | | |
| [webhook#16] | Attempt 1→2: 10 s base delay | B | | | | | |
| [webhook#17] | Attempt 2→3: 1 m | B | | | | | |
| [webhook#18] | Attempt 3→4: 5 m | B | | | | | |
| [webhook#19] | Attempt 4→5: 30 m | B | | | | | |
| [webhook#20] | Attempt 5→6: 2 h | B | | | | | |
| [webhook#21] | "After 5th attempt, delivery transitions to failed" | B | | | | | |
| [webhook#22] | "All retries include ±20% jitter" | B | | | | | |
| [webhook#23] | Cron: `* * * * * node ace tenant:webhooks:retry` | B | | | | | |
| [webhook#24] | REST: GET /admin/multitenancy/tenants/{id}/webhooks | B | | | | | |
| [webhook#25] | REST: POST /admin/multitenancy/tenants/{id}/webhooks | B | | | | | |
| [webhook#26] | REST: DELETE /admin/multitenancy/tenants/{id}/webhooks/{webhookId} | B | | | | | |
| [webhook#27] | REST: GET /admin/multitenancy/tenants/{id}/webhooks/{webhookId}/deliveries | B | | | | | |

## satellites/branding.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [branding#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=branding` | B | | | | | |
| [branding#2] | Column: tenant_id (FK + unique), logo_url, primary_color (hex), accent_color (hex), custom_domain | B | | | | | |
| [branding#3] | Column: smtp_host, smtp_port, smtp_user, smtp_password (AES-256-GCM encrypted), smtp_secure, smtp_from | B | | | | | |
| [branding#4] | Method: `update(tenantId, { logoUrl, primaryColor, customDomain, ... })` | B | | | | | |
| [branding#5] | Method: `get(tenantId)` — SMTP password is decrypted on read | B | | | | | |
| [branding#6] | "Setting custom_domain only stores the value" | B | | | | | |
| [branding#7] | "Wiring the request requires CustomDomainMiddleware" | B | | | | | |
| [branding#8] | "Wildcard TLS, LetsEncrypt, and Cloudflare-style cert flow are your job" | B | | | | | |
| [branding#9] | "SMTP passwords are encrypted with AES-256-GCM using APP_KEY" | B | | | | | |
| [branding#10] | "Rotation requires re-encryption" | B | | | | | |

## satellites/sso.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [sso#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=sso` | B | | | | | |
| [sso#2] | Requirement: `npm install jose` (optional peer dependency) | B | | | | | |
| [sso#3] | Step: "Generates state with randomBytes(16), single-use, 600 s TTL" | B | | | | | |
| [sso#4] | Step: "Generates nonce with randomBytes(16), bound to state" | B | | | | | |
| [sso#5] | Step: "Verifies the token endpoint returns an id_token" | B | | | | | |
| [sso#6] | Step: "Verifies the id_token against the IdP's JWKS (cached 1 h via discovery)" | B | | | | | |
| [sso#7] | Step: "Checks iss, aud, exp via jose.jwtVerify (60 s clock tolerance)" | B | | | | | |
| [sso#8] | Step: "Confirms the nonce in the id_token payload matches the value bound to state" | B | | | | | |
| [sso#9] | "Any mismatch throws and aborts the callback before claims surface" | A | | | | | |
| [sso#10] | "Verifies the discovery doc's issuer matches the requested issuer (OIDC Discovery 1.0 §4.3)" | B | | | | | |
| [sso#11] | "Applies validateExternalHttpsUrl to discovered token_endpoint and jwks_uri" | B | | | | | |
| [sso#12] | "Defends against SSRF (loopback, RFC 1918, link-local, cloud metadata, IPv6 brackets)" | A | | | | | |
| [sso#13] | Method: `upsert(tenantId, { issuerUrl, clientId, clientSecret, redirectUri, scopes })` | B | | | | | |
| [sso#14] | Method: `startLogin(tenantId) → { authUrl, state }` | B | | | | | |
| [sso#15] | Method: `handleCallback(tenantId, { code, state, cookieState }) → claims` | B | | | | | |

## satellites/metrics.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [metrics#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=metrics` | B | | | | | |
| [metrics#2] | Method: `increment(tenantId, 'requests' \| 'errors', amount = 1)` | B | | | | | |
| [metrics#3] | Method: `trackBandwidth(tenantId, bytes)` | B | | | | | |
| [metrics#4] | "Both are per-UTC-day Redis counters with a 48h TTL" | B | | | | | |
| [metrics#5] | Method: `flush(period?)` — Rolls Redis counters into tenant_metrics | B | | | | | |
| [metrics#6] | Cron: `0 1 * * * node ace tenant:metrics:flush` | B | | | | | |
| [metrics#7] | "Uses a SCAN cursor, safe against arbitrarily large key sets" | B | | | | | |
| [metrics#8] | Method: `getForTenant(tenantId, days = 30)` — Most recent N days of persisted rows | B | | | | | |
| [metrics#9] | "Current day's counters live in Redis until next flush" | B | | | | | |
| [metrics#10] | REST: GET /admin/multitenancy/tenants/{id}/metrics?days=30 | B | | | | | |
| [metrics#11] | "days is clamped to 1..365 (default 30)" | B | | | | | |
| [metrics#12] | "Counter increments hit Redis, not database. If Redis unavailable, increments for that window are lost." | A | | | | | |
| [metrics#13] | "The metric set is fixed (requests, errors, bandwidth)" | B | | | | | |
| [metrics#14] | "For arbitrary named metrics or gauges, use the OpenTelemetry integration" | B | | | | | |

## satellites/quotas.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [quota#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=quotas` | B | | | | | |
| [quota#2] | "Plans are declared statically in config/multitenancy.ts under the plans key" | A | | | | | |
| [quota#3] | "There is no upsertPlan / assignPlan API" | B | | | | | |
| [quota#4] | Config: `plans: { defaultPlan, definitions, getPlan, storage }` | B | | | | | |
| [quota#5] | "PlanDefinition.limits is Record<string, number>" | B | | | | | |
| [quota#6] | Middleware: `enforceQuota(quotaName, options?)` | B | | | | | |
| [quota#7] | "Apply per-route, not globally — TenantGuardMiddleware must run first" | A | | | | | |
| [quota#8] | Option: `{ enforce: false }` — track usage but never reject | B | | | | | |
| [quota#9] | Option: `{ amount: 1 }` — increment by more than 1 | B | | | | | |
| [quota#10] | Middleware step: Resolves active tenant | B | | | | | |
| [quota#11] | Middleware step: Looks up getLimit(tenant, quotaName) | B | | | | | |
| [quota#12] | Middleware step: Calls consume(tenant, quotaName, amount) | B | | | | | |
| [quota#13] | Middleware step: Throws QuotaExceededException (HTTP 429) on overrun | B | | | | | |
| [quota#14] | "consume runs a single Redis EVAL (Lua) script" | A | | | | | |
| [quota#15] | "GET the counter, compare against limit, INCRBY only when it fits" | A | | | | | |
| [quota#16] | "Concurrent callers cannot over-grant the quota" | A | | | | | |
| [quota#17] | Mode: rolling-day (default) — track / consume — 48-hour TTL counter | B | | | | | |
| [quota#18] | Mode: snapshot — setUsage — No TTL; app reports the new value | B | | | | | |
| [quota#19] | Policy: fail-open (default) — consume returns 0 and skips enforcement | B | | | | | |
| [quota#20] | Policy: fail-closed — consume throws DependencyUnavailableException (503) | B | | | | | |
| [quota#21] | Config: `resilience.redis.quota` — 'fail-open' \| 'fail-closed' | B | | | | | |
| [quota#22] | Method: `getUsage(tenant, quota) → Promise<number>` | B | | | | | |
| [quota#23] | Method: `snapshot(tenant) → Promise<QuotaStateSnapshot>` | B | | | | | |
| [quota#24] | "Plan resolution happens on every request via getPlan(tenant)" | B | | | | | |
| [quota#25] | "Counters are NOT reset when a plan changes" | A | | | | | |
| [quota#26] | "Call quotas.reset(tenant, quotaName) to zero explicitly" | B | | | | | |
| [quota#27] | REST: GET /admin/multitenancy/tenants/{id}/quotas | B | | | | | |
| [quota#28] | REST: PUT /admin/multitenancy/tenants/{id}/quotas/usage | B | | | | | |
| [quota#29] | REST: POST /admin/multitenancy/tenants/{id}/quotas/reset | B | | | | | |

## satellites/billing.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [billing#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=billing` | B | | | | | |
| [billing#2] | Requirement: `npm install stripe@^18` | B | | | | | |
| [billing#3] | "5 backoffice migrations: tenant_plans, stripe_customers, stripe_subscriptions, stripe_processed_events, stripe_meter_events" | B | | | | | |
| [billing#4] | "Publishes app/mailers/quota_warning_mailer.ts plus resources/views/emails/quota_warning.edge" | B | | | | | |
| [billing#5] | Env var: `STRIPE_API_KEY` — Secret key. Boot **rejects** sk_live_* when NODE_ENV !== 'production' | B | | | | | |
| [billing#6] | Env var: `STRIPE_WEBHOOK_SECRET` — Webhook signing secret from Stripe dashboard | B | | | | | |
| [billing#7] | Env var: `STRIPE_API_VERSION` (optional, default '2025-08-27.basil') — pin version | B | | | | | |
| [billing#8] | Env var: `STRIPE_ALLOW_LIVE_IN_DEV` — Set to 'true' to allow live keys outside production | B | | | | | |
| [billing#9] | "Boot **rejects** when STRIPE_API_KEY and NODE_ENV disagree about test vs live mode" | A | | | | | |
| [billing#10] | "Boot validates STRIPE_WEBHOOK_SECRET is non-empty and starts with whsec_" | A | | | | | |
| [billing#11] | Config: `billing.driver` — 'stripe' (required) | B | | | | | |
| [billing#12] | Config: `billing.stripe.apiKey` — from STRIPE_API_KEY | B | | | | | |
| [billing#13] | Config: `billing.stripe.webhookSecret` — from STRIPE_WEBHOOK_SECRET | B | | | | | |
| [billing#14] | Config: `billing.stripe.apiVersion` — optional pin | B | | | | | |
| [billing#15] | Config: `billing.stripe.timeout` (default 10_000 ms) | B | | | | | |
| [billing#16] | Config: `billing.stripe.maxNetworkRetries` (default 3) | B | | | | | |
| [billing#17] | Config: `billing.products` — Record<string, string> — Stripe product/price ID → plan name | B | | | | | |
| [billing#18] | Config: `billing.defaultPlan` — Plan assigned on cancel or unmapped product | B | | | | | |
| [billing#19] | Config: `billing.webhook.path` (default '/webhooks/stripe') — Must be in ignorePaths | B | | | | | |
| [billing#20] | Config: `billing.webhook.queueName` (default 'billing-events') | B | | | | | |
| [billing#21] | Config: `billing.webhook.idempotencyTtlDays` (default 90) — Retention for stripe_processed_events | B | | | | | |
| [billing#22] | Config: `billing.webhook.enforceIpAllowlist` (default false) | B | | | | | |
| [billing#23] | Config: `billing.webhook.allowedIps` — Literal IPs and/or CIDR ranges | B | | | | | |
| [billing#24] | Config: `billing.dunning.maxAttempts` (default 3) | B | | | | | |
| [billing#25] | Config: `billing.dunning.action` — 'none' \| 'downgrade' | B | | | | | |
| [billing#26] | Config: `billing.dunning.gracePeriodDays` (default 0) | B | | | | | |
| [billing#27] | Config: `billing.notifyOnQuotaExceeded` (default false) | B | | | | | |
| [billing#28] | Config: `billing.onTenantDelete` — 'cancel' \| 'detach' \| 'preserve' | B | | | | | |
| [billing#29] | Config: `billing.usageMapping` — Auto-bridge QuotaService.track to Stripe Meters | B | | | | | |
| [billing#30] | Config: `billing.observability.metrics` (default true if MetricsService active) | B | | | | | |
| [billing#31] | Config: `billing.observability.redactPii` (default true) | B | | | | | |

## satellites/impersonation.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [impersonate#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=impersonation` | B | | | | | |
| [impersonate#2] | Config: `impersonation: { secret, defaultDuration, maxDuration }` | B | | | | | |
| [impersonate#3] | "secret must be ≥ 32 chars; validated at boot" | A | | | | | |
| [impersonate#4] | Config: `impersonation.defaultDuration` (default 900 seconds, min 60) | B | | | | | |
| [impersonate#5] | Config: `impersonation.maxDuration` (default 86400 seconds) | B | | | | | |
| [impersonate#6] | Command: `node ace tenant:impersonate <tenantId> <userId> --admin=<id> --duration=<seconds> --reason="…"` | B | | | | | |
| [impersonate#7] | API: `issue({ tenantId, targetUserId, adminId, durationSeconds, reason, path }) → { token, redirectUrl }` | B | | | | | |
| [impersonate#8] | Middleware: `ImpersonationMiddleware` | B | | | | | |
| [impersonate#9] | "Reads token from imp query param or x-impersonation-token header" | B | | | | | |
| [impersonate#10] | "HMAC-verifies it with crypto.timingSafeEqual" | B | | | | | |
| [impersonate#11] | "Looks up Redis-backed grant (single-use; consumes on read)" | B | | | | | |
| [impersonate#12] | "Sets request.impersonation = { adminId, targetUserId, reason }" | B | | | | | |
| [impersonate#13] | Event: impersonation.granted — Records adminId, tenantId, targetUserId, reason, expiresAt | B | | | | | |
| [impersonate#14] | Event: impersonation.consumed — Records adminId, tenantId, targetUserId, IP, user-agent | B | | | | | |
| [impersonate#15] | Event: impersonation.expired — Records adminId, tenantId, targetUserId | B | | | | | |
| [impersonate#16] | "Tokens are HMAC-SHA256 over a fixed-size payload" | A | | | | | |
| [impersonate#17] | "Verification uses timingSafeEqual; constant-time" | A | | | | | |
| [impersonate#18] | "The shared secret is validated as ≥ 32 chars at provider boot" | A | | | | | |
| [impersonate#19] | "Tokens are single-use; Redis GETDEL consumes the grant" | A | | | | | |
| [impersonate#20] | "Tokens cannot be re-issued from a captured one; they sign a random nonce" | A | | | | | |

## admin-rest-api.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [api#1] | "The admin API is fail-closed — multitenancyAdminRoutes(...) requires a middleware option" | A | | | | | |
| [api#2] | "Throws at startup if you omit middleware" | A | | | | | |
| [api#3] | "The package ships NO built-in token check" | B | | | | | |
| [api#4] | Option: `middleware: false` — deliberately mount public (only behind trusted network) | B | | | | | |
| [api#5] | API: `multitenancyAdminRoutes({ prefix, middleware, resolveAdminActor? })` | B | | | | | |
| [api#6] | "middleware is required; omit it and the call throws" | B | | | | | |
| [api#7] | "resolveAdminActor callback is required for privileged actions (audit attribution)" | B | | | | | |
| [api#8] | "The spec is generated from the service contract" | B | | | | | |
| [api#9] | Endpoint: JSON spec: GET /admin/multitenancy/openapi.json | B | | | | | |
| [api#10] | Endpoint: Swagger UI: GET /admin/multitenancy/docs | B | | | | | |
| [api#11] | REST: GET /tenants | B | | | | | |
| [api#12] | REST: GET /tenants/{id} | B | | | | | |
| [api#13] | REST: POST /tenants | B | | | | | |
| [api#14] | REST: PUT /tenants/{id}/activate | B | | | | | |
| [api#15] | REST: PUT /tenants/{id}/suspend | B | | | | | |
| [api#16] | REST: DELETE /tenants/{id} | B | | | | | |
| [api#17] | REST: PUT /tenants/{id}/restore | B | | | | | |
| [api#18] | REST: PUT /tenants/{id}/maintenance | B | | | | | |
| [api#19] | REST: DELETE /tenants/{id}/maintenance | B | | | | | |
| [api#20] | REST: GET /tenants/{id}/audit-logs?from=…&to=… | B | | | | | |
| [api#21] | REST: GET /tenants/{id}/feature-flags | B | | | | | |
| [api#22] | REST: PUT /tenants/{id}/feature-flags/{key} | B | | | | | |
| [api#23] | REST: DELETE /tenants/{id}/feature-flags/{key} | B | | | | | |
| [api#24] | REST: GET /tenants/{id}/webhooks | B | | | | | |
| [api#25] | REST: POST /tenants/{id}/webhooks | B | | | | | |
| [api#26] | REST: DELETE /tenants/{id}/webhooks/{webhookId} | B | | | | | |
| [api#27] | REST: GET /tenants/{id}/webhooks/{webhookId}/deliveries | B | | | | | |

## authentication.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [auth#1] | "Lasagna does not ship an authentication system" | B | | | | | |
| [auth#2] | "You bring your own (AdonisJS @adonisjs/auth, custom guard, external IdP)" | B | | | | | |
| [auth#3] | "The package gives you the active tenant context, resolved before your auth runs" | B | | | | | |
| [auth#4] | "Tenant resolution must run before your auth middleware" | A | | | | | |
| [auth#5] | "If you authenticate first, a query against a tenant-scoped User model has no active tenant and will fail" | A | | | | | |
| [auth#6] | "Make your User model extend TenantBaseModel" | B | | | | | |
| [auth#7] | "Every auth query routes to the active tenant's schema automatically" | B | | | | | |
| [auth#8] | "Sessions are scoped per tenant; see the session bootstrapper" | B | | | | | |
| [auth#9] | "Operators and support staff use CentralBaseModel / BackofficeBaseModel" | B | | | | | |
| [auth#10] | "Authenticate them on non-tenant routes declared with router.central()" | B | | | | | |
| [auth#11] | "The Admin REST API is fail-closed: it refuses to mount without an auth middleware you provide" | B | | | | | |
| [auth#12] | "It asks for a resolveAdminActor callback so every privileged action is attributed to a real operator" | B | | | | | |
| [auth#13] | "When an operator needs to act as a tenant user, use the impersonation satellite" | B | | | | | |
| [auth#14] | "Impersonation tokens are time-boxed, single-use, HMAC-signed, bound to the target tenant, and fully audited" | B | | | | | |

## jobs.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [job#1] | Job: `InstallTenant` — Provision the tenant's schema/database, run migrations, init queue | B | | | | | |
| [job#2] | Job: `UninstallTenant` — Tear down storage, destroy tenant queue, soft-delete row | B | | | | | |
| [job#3] | Job: `BackupTenant` — Run pg_dump, mirror to S3 if configured | B | | | | | |
| [job#4] | Job: `RestoreTenant` — Run pg_restore against stored dump | B | | | | | |
| [job#5] | Job: `CloneTenant` — Provision destination + copy rows from source | B | | | | | |
| [job#6] | Job: `ProcessStripeEventJob` — Process verified Stripe webhook (retrieve, ordering guard, sync, mark completed) | B | | | | | |
| [job#7] | Job: `ReportUsageBatchJob` — Send aggregated meter events to Stripe in single batch | B | | | | | |
| [job#8] | Job: `BillingCleanupJob` — Purge stripe_processed_events older than webhook.idempotencyTtlDays | B | | | | | |
| [job#9] | "InstallTenant queued by tenant:create, POST /admin/.../tenants" | B | | | | | |
| [job#10] | "UninstallTenant queued by tenant:destroy (when not --keep-schema)" | B | | | | | |
| [job#11] | "BackupTenant queued by tenant:backups:run cron, ad-hoc dispatch" | B | | | | | |
| [job#12] | "RestoreTenant queued by tenant:restore" | B | | | | | |
| [job#13] | "CloneTenant queued by tenant:clone" | B | | | | | |
| [job#14] | Import: `{ InstallTenant, UninstallTenant, ... } from '@adonisjs-lasagna/saas-tenancy/jobs'` | B | | | | | |
| [job#15] | API: `InstallTenant.dispatch({ tenantId })` | B | | | | | |
| [job#16] | API: `BackupTenant.dispatch({ tenantId })` | B | | | | | |
| [job#17] | API: `RestoreTenant.dispatch({ tenantId, fileName })` | B | | | | | |
| [job#18] | API: `CloneTenant.dispatch({ sourceTenantId, destinationTenantId, schemaOnly, clearSessions })` | B | | | | | |
| [job#19] | Export: `CloneTenantPayload` as a public type | B | | | | | |
| [job#20] | "Every job binds an AsyncLocalStorage scope to the active tenant before doing any work" | B | | | | | |
| [job#21] | "Inside execute(): const logCtx = await app.container.make(TenantLogContext); return logCtx.run({ tenantId }, async () => { ... })" | B | | | | | |
| [job#22] | "tenancy.currentId() === tenantId" | B | | | | | |
| [job#23] | "tenantLogger() emits { tenantId } on every line" | B | | | | | |
| [job#24] | "Any service/repository/third-party client sees tenant context without threading it manually" | B | | | | | |
| [job#25] | "InstallTenant, UninstallTenant, BackupTenant, RestoreTenant, CloneTenant run before: and after: hooks" | B | | | | | |
| [job#26] | Hook phase: before: — throws aborts the job; queue retries per configured attempts | B | | | | | |
| [job#27] | Hook phase: after: — throws is logged and swallowed; operation continues | B | | | | | |
| [job#28] | "After the after: hook, the job dispatches the matching event (TenantProvisioned, TenantBackedUp, etc.)" | B | | | | | |
| [job#29] | "Each job overrides failed(error) to log a structured line keyed by tenantId" | B | | | | | |
| [job#30] | "The job stays on the queue's failed set per BullMQ defaults" | B | | | | | |
| [job#31] | Pattern: Wrap body in `tenancy.run(tenant, async () => { ... })` | B | | | | | |
| [job#32] | Example: Inside a job's execute(), resolve tenant repo, fetch tenant, call tenancy.run() | B | | | | | |
| [job#33] | Test: Job-context leak under interleaved tenants (`tests/integration/jobs/tenant_context.spec.ts`) — 3 tenants × 30 randomly-shuffled jobs | B | | | | | |

## testing.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [test#1] | "Most assertions don't need a real database" | B | | | | | |
| [test#2] | "Lasagna ships hermetic helpers for tenant-routing behaviour" | B | | | | | |
| [test#3] | "Reach for the SQLite memory driver only when your test needs real SQL round-trips" | B | | | | | |
| [test#4] | Import: `{ buildTestTenant, MockTenantRepository, setRequestTenant, withTenant } from '@adonisjs-lasagna/saas-tenancy/testing'` | B | | | | | |
| [test#5] | "Imports are tree-shaken; helpers don't pull in production services" | B | | | | | |
| [test#6] | Function: `buildTestTenant({ id, name, status, ... })` — Builds TenantModelContract-shaped object | B | | | | | |
| [test#7] | "Sensible defaults; override what you care about" | B | | | | | |
| [test#8] | Class: `MockTenantRepository([...tenants])` | B | | | | | |
| [test#9] | "Lives entirely in memory" | B | | | | | |
| [test#10] | "Useful for unit tests of services without database" | B | | | | | |
| [test#11] | "Implements each() (cursor pagination) the same way the real one does" | B | | | | | |
| [test#12] | Function: `setRequestTenant(ctx, tenant)` — For controller/middleware tests | B | | | | | |
| [test#13] | "Memoises onto the request" | B | | | | | |
| [test#14] | "ctx.request.tenant() now resolves without hitting the repo" | B | | | | | |
| [test#15] | Function: `withTenant(tenant, async () => { ... })` — Test-time convenience over tenancy.run() | B | | | | | |
| [test#16] | "Activates the bootstrapper registry around the callback" | B | | | | | |
| [test#17] | "The shape that survives in tests matches the shape in production" | B | | | | | |
| [test#18] | Config (test env): `cache: { factory: () => new InMemoryCache() }` | B | | | | | |
| [test#19] | Config (test env): `drive: { factory: () => new InMemoryDrive() }` | B | | | | | |
| [test#20] | "Clean way to keep tests fast without sacrificing behavioural fidelity" | B | | | | | |
| [test#21] | File: `bin/test.integration.ts` — boots real Ignitor rooted at fixture app | B | | | | | |
| [test#22] | Dir: `tests/fixtures/` — minimal AdonisJS app | B | | | | | |
| [test#23] | Dir: `examples/api/` — complete reference app with 111 e2e tests | B | | | | | |
| [test#24] | "Reference suite uses compose.test.yml to bring up Postgres, Redis, MailCatcher" | B | | | | | |
| [test#25] | Container: `postgres:16-alpine` — Real PG for integration suite | B | | | | | |
| [test#26] | Container: `redis:7-alpine` — Real Redis for cache + queue + rate-limit specs | B | | | | | |
| [test#27] | Container: `ghcr.io/navikt/mock-oauth2-server` — Wire-compliant OIDC for SSO real-server spec | B | | | | | |
| [test#28] | Container: `minio/minio` — S3-compatible store for BackupService S3 spec | B | | | | | |
| [test#29] | "test-e2e-demo job additionally brings up pg_dump/pg_restore and MailCatcher" | B | | | | | |

## contextual-logging.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [log#1] | "TenantLogContext owns the AsyncLocalStorage" | B | | | | | |
| [log#2] | "tenancy.run() is the public entry point that activates a context outside HTTP" | B | | | | | |
| [log#3] | API: `tenancy.run(tenant, async () => { ... })` | B | | | | | |
| [log#4] | "Inside the callback: tenancy.currentId() === tenant.id" | B | | | | | |
| [log#5] | "Inside the callback: tenantLogger() emits { tenantId } on every line" | B | | | | | |
| [log#6] | "Lucid models extending TenantBaseModel route to this tenant's schema" | B | | | | | |
| [log#7] | "Any async continuation (setTimeout, await fetch, Promise.all) sees the same context" | B | | | | | |
| [log#8] | Function: `tenantLogger() → Logger` — AdonisJS root logger with active tenant context bound | B | | | | | |
| [log#9] | "Outside any tenancy.run() scope, returns the plain root logger" | B | | | | | |
| [log#10] | "No penalty for calling it everywhere" | B | | | | | |
| [log#11] | "Uses Pino's native child(bindings) API" | B | | | | | |
| [log#12] | API: `TenantLogContext.run({ tenantId, requestId, traceId, ... }, async () => { ... })` | B | | | | | |
| [log#13] | "Every log line within this scope carries all fields" | B | | | | | |
| [log#14] | "Each built-in job already wraps its execute() in tenancy.run()" | B | | | | | |
| [log#15] | API: `tenancy.currentId() → string \| undefined` — synchronous, cheap | B | | | | | |
| [log#16] | API: `await tenancy.current() → TenantModelContract \| null` — hits the repository | B | | | | | |
| [log#17] | "For one-off log enrichment, use currentId()" | B | | | | | |
| [log#18] | "tenancy.run() and TenantLogContext.run() honor a stack" | B | | | | | |
| [log#19] | "An inner scope shadows the outer scope while it's active, then the outer is restored on return" | B | | | | | |

## health.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [health#1] | Endpoint: `GET /livez` — Liveness. Never touches DB or Redis. Always 200 while event loop is alive. | B | | | | | |
| [health#2] | Endpoint: `GET /readyz` — Readiness. Every registered check passes. 200 when ok/degraded; 503 when fail. | B | | | | | |
| [health#3] | Endpoint: `GET /healthz` — Same data as /readyz, full JSON report. 200 / 503. | B | | | | | |
| [health#4] | Endpoint: `GET /metrics` — Prometheus text exposition. 200. | B | | | | | |
| [health#5] | API: `multitenancyRoutes()` — root paths | B | | | | | |
| [health#6] | API: `multitenancyRoutes({ prefix: '/internal' })` — /internal/livez, etc. | B | | | | | |
| [health#7] | API: `multitenancyRoutes({ metrics: false })` — skip /metrics | B | | | | | |
| [health#8] | API: `multitenancyRoutes({ health: false, metrics: false })` — opt-in via options | B | | | | | |
| [health#9] | Check: `backofficeDbCheck` — SELECT 1 against backoffice connection | B | | | | | |
| [health#10] | Check: `redisCheck` — PING against default Redis | B | | | | | |
| [health#11] | Check: `makeCircuitBreakerCheck(fn)` — Reports fail if any tenant circuit is OPEN | B | | | | | |
| [health#12] | Check: `billingHealthCheck` — Pings Stripe API + asserts webhooks flowing (when active subs exist) | B | | | | | |
| [health#13] | Type: `HealthCheckFn = async () → Promise<CheckResult> \| CheckResult` | B | | | | | |
| [health#14] | API: `health.addCheck('custom_dependency', checkFn)` | B | | | | | |
| [health#15] | "HealthService enforces a 2-second timeout per check" | A | | | | | |
| [health#16] | Status: ok — every check passed (or no checks registered) | B | | | | | |
| [health#17] | Status: degraded — at least one passed, at least one failed (200 so Kubernetes keeps routing) | B | | | | | |
| [health#18] | Status: fail — every check failed (503) | B | | | | | |
| [health#19] | Metric: `multitenancy_tenants_total` — gauge | B | | | | | |
| [health#20] | Metric: `multitenancy_tenants_by_status{status="..."}` — gauge | B | | | | | |
| [health#21] | Metric: `multitenancy_circuit_state{tenant_id="..."}` — gauge (0=CLOSED, 1=HALF_OPEN, 2=OPEN) | B | | | | | |
| [health#22] | Metric: `multitenancy_circuit_failures_total{...}` — counter | B | | | | | |
| [health#23] | Metric: `multitenancy_circuit_successes_total{...}` — counter | B | | | | | |
| [health#24] | Metric: `multitenancy_queue_jobs{tenant_id,queue,state}` — gauge (state ∈ waiting, active, completed, failed, delayed) | B | | | | | |
| [health#25] | Metric: `multitenancy_uptime_seconds` — gauge | B | | | | | |
| [health#26] | API: `collectSnapshot()` — gather metrics from current state | B | | | | | |
| [health#27] | API: `renderPrometheus(snapshot)` — format as Prometheus text exposition | B | | | | | |

## resilience.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [resilience#1] | API: `ResilienceService.run({ dependency, operation, policy, tenantId, fallback, run })` | B | | | | | |
| [resilience#2] | "Keep only the dependency call inside run" | B | | | | | |
| [resilience#3] | Policy: fail-open — Returns fallback() and continues. Availability over correctness. | B | | | | | |
| [resilience#4] | Policy: fail-closed — Throws DependencyUnavailableException (503 + Retry-After). Correctness over availability. | B | | | | | |
| [resilience#5] | Config: `resilience: { redis: { quota: 'fail-open', rateLimit: 'fail-closed' }, observe: true }` | B | | | | | |
| [resilience#6] | Key: `defaultPolicy` (default 'fail-closed') | B | | | | | |
| [resilience#7] | Key: `redis.quota` (default 'fail-open') | B | | | | | |
| [resilience#8] | Key: `redis.rateLimit` (default 'fail-closed') | B | | | | | |
| [resilience#9] | Key: `redis.cache` (default 'fail-open') | B | | | | | |
| [resilience#10] | Key: `redis.metrics` (default 'fail-open') | B | | | | | |
| [resilience#11] | Key: `observe` (default true) — emit DependencyDegraded + log + OTel span event | B | | | | | |
| [resilience#12] | Exception: `DependencyUnavailableException` — clean 503 with Retry-After, carries dependency, operation, tenantId | B | | | | | |
| [resilience#13] | Event: `DependencyDegraded` — fires whenever a wrapped call fails and policy kicks in | B | | | | | |
| [resilience#14] | Payload: { dependency, operation, tenantId, policy, errorCode } | B | | | | | |
| [resilience#15] | "QuotaService.consume and track route Redis through the policy" | B | | | | | |
| [resilience#16] | "RateLimitMiddleware emits the same DependencyDegraded event" | B | | | | | |

## read-replicas.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [replica#1] | Config: `tenantReadReplicas: { hosts, strategy, connectionSuffix }` | B | | | | | |
| [replica#2] | Config: `hosts: [ { host, name, port?, user?, password? } ]` | B | | | | | |
| [replica#3] | Config: `strategy: 'round-robin' \| 'random' \| 'sticky' (default 'round-robin')` | B | | | | | |
| [replica#4] | Config: `connectionSuffix: '_read' (default)` | B | | | | | |
| [replica#5] | Strategy: round-robin (default) — Global in-memory cursor cycles through hosts | B | | | | | |
| [replica#6] | Strategy: random — Math.random() selects a host per call | B | | | | | |
| [replica#7] | Strategy: sticky — SHA-1 of tenant.id modulo pool size — same tenant lands on same replica | B | | | | | |
| [replica#8] | API: `replicas.resolve(tenant) → Promise<Lucid Connection \| null>` | B | | | | | |
| [replica#9] | "Returns null when no replicas configured" | B | | | | | |
| [replica#10] | "Lucid connection is registered on first use under stable name" | B | | | | | |
| [replica#11] | "resolve() returns a connection for the chosen replica regardless of whether it's reachable" | A | | | | | |
| [replica#12] | "There is NO automatic failover to the primary" | A | | | | | |
| [replica#13] | "An unreachable replica surfaces as an error at query time, not at resolve() time" | A | | | | | |
| [replica#14] | Doctor check: `tenant:doctor --check=replicaLag` — SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) against every replica | B | | | | | |
| [replica#15] | Thresholds: warn at 30s (default), error at 120s (default) | B | | | | | |
| [replica#16] | API: `replicas.resetCursor()` — reset round-robin counter | B | | | | | |
| [replica#17] | API: `replicas.pickHost(tenantId)` — convenience accessor for chosen replica host | B | | | | | |

## performance.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [perf#1] | Claim: "Benchmark results generated by npm run bench:report" | B | | | | | |
| [perf#2] | Claim: "Read the shape, not the absolutes — relative cost across drivers and code paths" | B | | | | | |
| [perf#3] | Claim: "header resolution is far cheaper than subdomain/path" | B | | | | | |
| [perf#4] | Claim: "rowscope-pg reads faster than schema-pg ≈ database-pg" | B | | | | | |
| [perf#5] | "Open tenant connections are bounded by the eviction grace window, NOT by maxTenantConnections" | A | | | | | |
| [perf#6] | "Under the default 30s grace a burst of N active tenants opens ~N connections" | B | | | | | |

## deployment.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [deploy#1] | Target: Single-VPS Docker Compose for staging or low-volume production | B | | | | | |
| [deploy#2] | Target: Kubernetes via Helm for HA / multi-region | B | | | | | |
| [deploy#3] | Target: Security hardening checklist for both | B | | | | | |
| [deploy#4] | Service: postgres-primary — postgres:16-alpine, wal_level=replica, replication user | B | | | | | |
| [deploy#5] | Service: postgres-replica — postgres:16-alpine, streaming replica, hot standby | B | | | | | |
| [deploy#6] | Service: redis — redis:7-alpine, password-protected, AOF persistence | B | | | | | |
| [deploy#7] | Service: app (×3) — Built from deploy/Dockerfile, health checks against /readyz | B | | | | | |
| [deploy#8] | Service: nginx — nginx:1.27-alpine, reverse proxy, JSON access logs | B | | | | | |

## production-checklist.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [checklist#1] | "Auth middleware wired in front of multitenancyAdminRoutes(...) and resolveAdminActor set" | B | | | | | |
| [checklist#2] | "Database role used by the app does NOT have SUPERUSER or BYPASSRLS" | B | | | | | |
| [checklist#3] | "A separate database role handles audit-log retention with trigger disabled in controlled window" | B | | | | | |
| [checklist#4] | "multitenancy.config.isolation.rowScopeMode left at default unless every cross-tenant query audited" | B | | | | | |
| [checklist#5] | "CustomDomainMiddleware registered with strict: true if accepting tenant header AND using custom domains" | B | | | | | |
| [checklist#6] | "Backup storage volume / S3 bucket encrypted at rest and lifecycle-managed" | B | | | | | |
| [checklist#7] | "Rate-limit policy on RateLimitUnavailableException decided and tested (fail-open vs fail-closed)" | B | | | | | |
| [checklist#8] | "OIDC client_secret, encryption keys, S3 credentials live in secrets manager, not .env" | B | | | | | |
| [checklist#9] | "tenant:doctor runs on cron in production and pages on error-level findings" | B | | | | | |
| [checklist#10] | "Health probes wired (/livez, /readyz, /healthz, /metrics)" | B | | | | | |

## stability.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [stable#1] | Label: Stable — Production ready, full semver promise. **Nothing carries this label yet.** | C | N/A | — (policy declaration; honest: nothing labeled stable) | — | none | consistent w/ roadmap/faq |
| [stable#2] | Label: Release candidate — feature complete, green in CI vs real PG/Redis, API final, stable withheld | C | N/A | — (policy) | CI-green part factual: see stable#4 | none | |
| [stable#3] | Label: Experimental — surface may change in any minor, outside semver promise | C | N/A | — (policy) | — | none | |
| [stable#4] | Criterion: Real integration green in CI against Postgres and Redis (true today for core) | A | VERIFIED | .github/workflows/ci.yml integration job (PG16/Redis/mock-oidc/MinIO) | baseline 2026-06-10: integration 370 passed vs real PG+Redis | none | |
| [stable#5] | Criterion: independent security review (not done yet) | C | N/A | honest "not done" statement; consistent with roadmap.md | — | none | |
| [stable#6] | Criterion: production mileage (not done yet) | C | N/A | honest "not done" statement | — | none | |
| [stable#7] | "Stable surfaces follow semver strictly" | C | N/A | policy (vacuous today: nothing stable) | — | none | |
| [stable#8] | "RC surfaces semver-frozen with loud-changelog correction caveat" | C | N/A | policy | — | none | |
| [stable#9] | "Experimental surfaces excluded from the promise" | C | N/A | policy | — | none | |
| [stable#10] | Core: Schema isolation (schema-pg) — Release candidate | B | VERIFIED | schema_pg_driver.ts exists; label = declaration | unit + integration schema_pg specs; cross_tenant_e2e | none | label consistent across pages |
| [stable#11] | Core: Database isolation (database-pg) — Release candidate | B | VERIFIED | database_pg_driver.ts | unit + integration database_pg specs | none | |
| [stable#12] | Core: Row-scope isolation (rowscope-pg) — Release candidate | B | VERIFIED | rowscope_pg_driver.ts | rowscope unit/integration + rls specs | none | |
| [stable#13] | Core: sqlite-memory driver — Testing only | B | VERIFIED | sqlite_memory_driver.ts | sqlite unit + sqlite_memory_lifecycle integration | none | "testing only" framing consistent |
| [stable#14] | Core: Tenant resolution — Release candidate | B | VERIFIED | resolvers/builtins.ts ×5 | tenant_resolver + builtin_resolvers + resolver_registry specs; e2e resolution_strategies | none | |
| [stable#15] | Core: TenantAdapter + base-model routing — Release candidate | B | VERIFIED | models/adapters + base | unit + integration adapter specs | none | |
| [stable#16] | Core: Connection LRU, budget, optional hard cap — Release candidate | B | VERIFIED | connection_lru.ts | connection_lru.spec (17) + universal_connection_cap + connection_eviction_safety | none | |
| [stable#17] | Core: Circuit breaker — Release candidate | B | VERIFIED | circuit_breaker_service.ts | unit (18) + integration (Redis persistence) | none | |
| [stable#18] | Core: Dependency resilience (ResilienceService) — Release candidate | B | VERIFIED | resilience_service.ts | resilience_service.spec + quota_resilience | new-test:T4 (defaults pinning, verify-first) | |
| [stable#19] | Core: Contextual logging (AsyncLocalStorage) — Release candidate | B | VERIFIED | tenant_log_context.ts, tenant_logger.ts | tenant_log_context + tenant_logger specs; e2e contextual_logging | none | |
| [stable#20] | Core: Tenant lifecycle, hooks, lifecycle events — Release candidate | B | VERIFIED | jobs + hook_registry + events | tenant_lifecycle + lifecycle_dispatch + hook_registry; e2e lifecycle_events | none | |
| [stable#21] | Core: Soft delete + recycle bin — Release candidate | B | VERIFIED | utils soft_delete + tenant_purge_expired.ts | soft_delete.spec; e2e commands | none | |
| [stable#22] | Core: Health probes — Release candidate | B | VERIFIED | health/ | health_service.spec + metrics_exporter.spec | none | |
| [stable#23] | Core: Doctor (base checks) — Release candidate | B | VERIFIED | doctor/ ×9 checks | doctor unit ×6 + doctor_checks_real | none | |
| [stable#24] | Core: Plans and quotas — Experimental | B | VERIFIED | quota_service.ts | quota specs ×3 | none | |
| [stable#25] | Core: Read-replica routing — Experimental | B | VERIFIED | read_replica_service.ts | unit + integration + e2e replicas | none | |
| [stable#26] | Core: Audit logs — Experimental | B | VERIFIED | audit_log_service.ts | audit_log_service + audit_immutability | none | |
| [stable#27] | Core: Webhooks — Experimental | B | VERIFIED | webhook_service.ts | webhook_service (15+) + e2e webhooks_delivery | none | |
| [stable#28] | Core: Branding — Experimental | B | VERIFIED | branding_service.ts | branding_service.spec | none | |
| [stable#29] | Core: Feature flags — Experimental | B | VERIFIED | feature_flag_service.ts | feature_flag_service.spec (8+) | none | |
| [stable#30] | Core: Metrics — Experimental | B | VERIFIED | metrics_service.ts | metrics_service.spec | none | |
| [stable#31] | Core: Impersonation — Experimental | B | VERIFIED | impersonation_service.ts | impersonation specs ×4 | none | |
| [stable#32] | Satellite: @adonisjs-lasagna/admin — Experimental | B | VERIFIED | packages/admin | openapi.spec + e2e admin_full | new-test:T9 (fail-closed) | |
| [stable#33] | Satellite: @adonisjs-lasagna/sso — Experimental | B | VERIFIED | packages/sso | sso specs ×3 + authorize.spec | none | |
| [stable#34] | Satellite: @adonisjs-lasagna/billing — Experimental | B | VERIFIED | packages/billing | 27 integration + 6 unit + real smoke | none | |
| [stable#35] | Satellite: @adonisjs-lasagna/backup — Experimental | B | VERIFIED | packages/backup | 5 unit + backup_s3 + e2e backups_real | new-test:T7 | |

## known-limitations.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [limit#1] | "PostgreSQL only. No MySQL/MariaDB." | A | | | | | |
| [limit#2] | "Node.js ≥ 24 required by AdonisJS 7 and Lucid 22" | B | | | | | |
| [limit#3] | "No independent external security review yet. Isolation core is release-candidate." | B | | | | | |
| [limit#4] | "Single maintainer (mitigated by test and documentation depth)" | B | | | | | |
| [limit#5] | "No built-in driver-to-driver migration. Switching after launch is a planned data migration." | B | | | | | |
| [limit#6] | "rowscope-pg: non-grouped top-level orWhere can escape the auto-scope" | A | | | | | |
| [limit#7] | "Cross-layer Lucid relationships unsupported (tenant/backoffice/central on different schemas)" | B | | | | | |
| [limit#8] | "Connection-cap default favors availability (isolation.enforceConnectionCap defaults false)" | A | | | | | |
| [limit#9] | "Quotas and rate limiting can fail open on Redis outage (depending on resilience policy)" | B | | | | | |
| [limit#10] | "Read replicas have no automatic failover and can serve stale reads" | A | | | | | |
| [limit#11] | "Feature flags are boolean only — no built-in percentage rollout" | A | | | | | |
| [limit#12] | "Metrics track a fixed counter set (requests, errors, bandwidth), not arbitrary named metrics" | B | | | | | |

## gotchas.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [gotcha#1] | "Always resolve the tenant via the helper — reading the header directly bypasses resolverStrategy/resolverChain" | A | | | | | |
| [gotcha#2] | "The provisioning → active race (transient 503s) — correct behavior, wait for TenantActivated" | B | | | | | |
| [gotcha#3] | "fail-open quotas silently stop enforcing on Redis outage — subscribe to DependencyDegraded to alert" | A | | | | | |
| [gotcha#4] | "Read replicas can serve stale data — no lag check, no auto-failover" | A | | | | | |
| [gotcha#5] | "Custom domains + header strategy — mismatched header rejected with TenantHeaderDomainMismatchException (400)" | A | | | | | |
| [gotcha#6] | "Circuit breaker reopens after restart — breaker state persisted to Redis and restored on process start" | A | | | | | |
| [gotcha#7] | "Replaying old Stripe events works even past 30 days — webhook controller persists PII-stripped copy in stripe_processed_events.payload" | B | | | | | |
| [gotcha#8] | "A resolved tenant whose database is down returns 503, never central" | A | | | | | |
| [gotcha#9] | "The SSRF guard validates the URL, not the resolved connection IP — rejects non-HTTPS and private ranges" | B | | | | | |

## cookbook/stripe-quotas.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cookbook-stripe#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=billing` | B | | | | | |
| [cookbook-stripe#2] | Command: `npm install stripe@^18` | B | | | | | |
| [cookbook-stripe#3] | Migrations: 5 backoffice migrations published | B | | | | | |
| [cookbook-stripe#4] | Command: `node ace migration:run --connection=backoffice` | B | | | | | |
| [cookbook-stripe#5] | Env: STRIPE_API_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_API_VERSION | B | | | | | |
| [cookbook-stripe#6] | Config: plans.defaultPlan, plans.definitions, plans.storage='auto', billing block | B | | | | | |

## faq.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [faq#1] | PostgreSQL-only; no MySQL/MariaDB path | B | | | | | |
| [faq#2] | rowscope-pg uses PostgreSQL Row-Level Security for its hard boundary | B | | | | | |
| [faq#3] | Driver guidance: schema-pg default; database-pg max isolation/heaviest; rowscope-pg lightest on connections | C | | | | | |
| [faq#4] | No built-in driver-to-driver migration tool; switching is a planned data migration | A | | | | | |
| [faq#5] | Redis backs circuit-breaker persisted state, rate limiter, quota counters, cache bootstrapper, queue | B | | | | | |
| [faq#6] | Resilience policy controls Redis-down behavior (fail-open vs fail-closed) so outage degrades predictably | A | | | | | |
| [faq#7] | Replica routing: round-robin/random/sticky with stable connection naming; no automatic failover by design | B | | | | | |
| [faq#8] | Cross-layer Lucid relationships/FKs unsupported; store other layer's id as plain column | B | | | | | |
| [faq#9] | 1.0: isolation core RC (green in CI vs real PG/Redis); stable withheld pending external review + mileage; satellites experimental | C | | | | | |
| [faq#10] | Testing helpers: buildTestTenant, MockTenantRepository, setRequestTenant, withTenant + sqlite-memory driver | B | | | | | |

## comparison.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [compare#1] | stancl positioning narrative ("covers the same ground and adds operational surface; also has gaps") | C | | | | | |
| [compare#2] | ComparisonTable component data: every "Lasagna" cell (yes/partial/no) must match code | A | | | | | data source in docs/.vitepress/theme/components/ComparisonTable.vue |
| [compare#3] | "Schema-per-tenant + read replicas + circuit breaker out of the box" | B | | | | | |
| [compare#4] | "The doctor command and CI-friendly health gates" | B | | | | | |
| [compare#5] | "A built-in REST admin API + OpenAPI 3.1 spec" | B | | | | | |
| [compare#6] | "Per-tenant impersonation with HMAC + audit" | B | | | | | |
| [compare#7] | Phase-4 roadmap items (Discord, dashboard pkg, create-lasagna-saas, 1.0 release) framed as future | C | | | | | |
| [compare#8] | GitHub repo link (Arcoders/Adonisjs-lasagna-saas-tenancy) | C | | | | | |

## roadmap.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [roadmap#1] | Isolation core = release candidate, feature-complete, green in CI vs real PG/Redis | C | | | | | consistency vs stability.md |
| [roadmap#2] | Satellites (billing, SSO, admin, backup + in-core opt-ins) = experimental | C | | | | | consistency vs stability.md |
| [roadmap#3] | stable gated on independent security review + production mileage; moves inside 1.x without major bump | C | | | | | |
| [roadmap#4] | Under-consideration list framed as directions, not commitments | C | | | | | |
| [roadmap#5] | Semver: breaking change to stable surface requires major; experimental may change in minor with changelog note | C | | | | | |

## release-notes.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [relnotes#1] | Page generated from packages/core/CHANGELOG.md via docs/scripts/sync-changelog.mjs (derived page) | B | | | | | confirm page in sync with CHANGELOG |
| [relnotes#2] | Satellite table lists sso/billing/admin/backup with versions read from their package.json | B | | | | | |
| [relnotes#3] | Changelog content accuracy (spot-check the 1.0.0 entry against reality) | C | | | | | |

## upgrade-to-1.0.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [upgrade#1] | Satellites (billing, SSO, admin REST API, backup/clone) moved out of core into own packages | B | | | | | |
| [upgrade#2] | resolver.legacyAdapterFallback now defaults to false | A | | | | | |
| [upgrade#3] | Core keeps leaf satellites: audit, feature flags, metrics, webhooks, branding, quotas, impersonation | B | | | | | |
| [upgrade#4] | `npm i @adonisjs-lasagna/{admin,sso,billing,backup}`; each declares core as peer | B | | | | | |
| [upgrade#5] | `multitenancyAdminRoutes` imports from @adonisjs-lasagna/admin | B | | | | | |
| [upgrade#6] | Old /admin subpath = throwing shim with clear "moved to @adonisjs-lasagna/admin" message; drops after one minor | A | | | | | |
| [upgrade#7] | Admin routes fail-closed: pass middleware, or middleware:false for public; omitting both throws at boot | A | | | | | |
| [upgrade#8] | SSO: SsoService + TenantSsoConfig import from @adonisjs-lasagna/sso; no shim (came from shared barrels) | B | | | | | |
| [upgrade#9] | create_tenant_sso_configs_table stub still ships with core; `configure --with=sso` keeps provisioning it | B | | | | | |
| [upgrade#10] | Billing: BillingService + multitenancyBillingRoutes import from @adonisjs-lasagna/billing | B | | | | | |
| [upgrade#11] | Billing pkg carries Stripe models, billing events/jobs, BillingException, VerifyStripeWebhookMiddleware, billingHealthCheck, MockStripe, signWebhookPayload | B | | | | | |
| [upgrade#12] | Entry points '@adonisjs-lasagna/billing/provider' and '/commands' registered in adonisrc.ts | B | | | | | |
| [upgrade#13] | Billing provider: validates Stripe config at boot, wires quota/usage/tenant-delete listeners, registers jobs, drains metering on shutdown | A | | | | | |
| [upgrade#14] | Stripe config types stay in core (config.billing still typed) | B | | | | | |
| [upgrade#15] | Backup: BackupService/CloneService from @adonisjs-lasagna/backup; BackupTenant/RestoreTenant/CloneTenant jobs + tenant:backup, tenant:backup:list, tenant:restore, tenant:import, tenant:clone, tenant:backups:run commands move with it | B | | | | | |
| [upgrade#16] | Backup provider registers backup queue jobs + backup_recency doctor check; without it doctor skips the check and dispatched backup jobs dead-letter | A | | | | | |
| [upgrade#17] | @aws-sdk/client-s3 is optional peer of backup | B | | | | | |
| [upgrade#18] | BackupMetadata / CloneResult types stay in core /types | B | | | | | |
| [upgrade#19] | legacyAdapterFallback semantics: outside active context, TenantAdapter resolves via resolver chain synchronously; `resolver.legacyAdapterFallback: true` restores 0.x behavior | A | | | | | |
| [upgrade#20] | backup/restore/clone hook phases + lifecycle events unchanged in core | B | | | | | |

## contributing.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [contrib#1] | Dev setup: clone URL + npm install + typecheck/test/test:integration commands as documented | B | | | | | |
| [contrib#2] | `docker compose -f compose.test.yml up -d` brings up integration infra | B | | | | | file existence |
| [contrib#3] | Japa filters: `--files` and `--tests` examples | B | | | | | |
| [contrib#4] | eslint.config.js extends @adonisjs/eslint-config; prettier @adonisjs/prettier-config; no npm scripts for either | B | | | | | |
| [contrib#5] | snake_case files, PascalCase default-exported classes, .js imports, exports+typesVersions discipline | B | | | | | |
| [contrib#6] | Issue template asks for version, minimal repro, actual-vs-expected | C | | | | | check .github templates |
| [contrib#7] | GitHub project board link | C | | | | | |
| [contrib#8] | MIT license | B | | | | | |

## showcase.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [showcase#1] | examples/api exercises every feature: six bootstrappers, doctor, backups, replicas, full satellite suite | B | | | | | |
| [showcase#2] | "111-test e2e suite" exact count | B | | | | | |
| [showcase#3] | Run instructions: `docker compose -f compose.test.yml up -d` + `npm run test:e2e` | B | | | | | file existence |
| [showcase#4] | e2e covers provisioning, isolation, contextual logging, doctor, backup+restore round-trip, quotas, lifecycle events, admin API, mail, replica strategies, webhook state machine | B | | | | | |
| [showcase#5] | GitHub tree link to examples/api | C | | | | | |
| [showcase#6] | docs/data/showcase.yml "will exist once we have the second submission" (aspirational) | C | | | | | |

## sponsor.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [sponsor#1] | MIT, no premium tier, no locked features | C | | | | | |
| [sponsor#2] | Sponsor links "land here once set up" (aspirational, clearly marked) | C | | | | | |

## cookbook/index.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cookbook#1] | Recipe table: 5 recipes exist at linked paths with accurate one-liners | B | | | | | |
| [cookbook#2] | Link anchors: /docs/bootstrappers/, /docs/commands#doctor | B | | | | | |

## cookbook/adding-features-incrementally.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [addinc#1] | configure is additive + idempotent; re-runs never duplicate a migration (scans migrations dir, skips existing) | A | | | | | |
| [addinc#2] | config/multitenancy.ts and app/models/backoffice/tenant.ts never overwritten on re-run; config blocks printed, never injected | A | | | | | |
| [addinc#3] | Bare `configure` with no --with selects every satellite | B | | | | | |
| [addinc#4] | Core satellites: audit, feature_flags, webhooks, branding, metrics, quotas ship inside core | B | | | | | |
| [addinc#5] | Packaged satellites: sso, billing as own npm packages (heavy peers jose/stripe) | B | | | | | |
| [addinc#6] | Per-satellite reference table: --with names, kind, install, config block, extra wiring — each cell accurate | B | | | | | 10 rows in doc table |
| [addinc#7] | rls + maintenance are opt-in: never published by bare configure, only when named with --with | A | | | | | |
| [addinc#8] | quotas prints a `plans` config block; billing prints config + wiring instructions at end of run | B | | | | | |
| [addinc#9] | `enforceQuota('apiCallsPerDay')` import from /middleware, used via .use() | B | | | | | |
| [addinc#10] | Billing wiring: multitenancyBillingRoutes() + '/webhooks/stripe' in ignorePaths | B | | | | | |
| [addinc#11] | Env vars STRIPE_API_KEY / STRIPE_WEBHOOK_SECRET | B | | | | | |
| [addinc#12] | Billing bundle ordering: tenant_plans created before stripe_* tables | B | | | | | |
| [addinc#13] | Test guidance: MockStripe via BillingService.__setStripeForTests, signWebhookPayload(body, secret), STRIPE_TEST_API_KEY gating, PII redaction on by default | B | | | | | |
| [addinc#14] | Package's own suite: satellite-coexistence spec drives every satellite; example app e2e adds billing with MockStripe | B | | | | | |

## cookbook/custom-domain-https.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cdhttps#1] | Cloudflare for SaaS recipe (external service steps) | C | | | | | |
| [cdhttps#2] | CustomDomainMiddleware maps hostname to tenant via branding.custom_domain | B | | | | | |
| [cdhttps#3] | cert-manager + DNS-01 YAML recipe (external) | C | | | | | |
| [cdhttps#4] | Default precedence: explicit x-tenant-id header wins over Host-resolved tenant (back-compat) | A | | | | | |
| [cdhttps#5] | `middleware.customDomain({ strict: true })` rejects conflicts with E_TENANT_HEADER_DOMAIN_MISMATCH (400) | A | | | | | |
| [cdhttps#6] | Link anchors: /docs/routing#strict-mode, /docs/routing#custom-domain-mapping, /docs/satellites/branding | B | | | | | |

## cookbook/custom-isolation-driver.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cdriver#1] | Import: `{ IsolationDriver, TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/services'` resolves | B | | | | | TenantModelContract from /services is suspicious |
| [cdriver#2] | IsolationDriver contract: name, provision, destroy, reset, connect, disconnect, connectionName(tenantId), migrate(tenant, {dryRun}) — exact shape | A | | | | | |
| [cdriver#3] | `registry.register('my-driver', new MyDriver())` two-arg signature; container.make(IsolationDriverRegistry) | B | | | | | |
| [cdriver#4] | config isolation.driver accepts a custom driver name (type permits beyond the 4 built-ins) | B | | | | | |
| [cdriver#5] | assertSafeIdentifier exported from /services; enforces [a-zA-Z0-9_-]{1,63}; shipped drivers call it at every entry | A | | | | | |
| [cdriver#6] | Idempotency contract: provision re-callable; destroy runs after disconnect; reset = destroy + provision | B | | | | | |

## cookbook/multi-region-replicas.md (re-sweep)

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [mregion#1] | tenantReadReplicas shape { strategy, hosts, connectionSuffix? }; no enabled flag; no per-tenant pinning callback | B | | | | | |
| [mregion#2] | Each host may override user/password; otherwise inherits primary tenant connection pg config | B | | | | | |
| [mregion#3] | Strategy semantics: round-robin in-memory cursor per process; random per call; sticky hash of tenant.id | B | | | | | |
| [mregion#4] | `replicas.resolve(tenant)` returns connection; null when tenantReadReplicas unset | A | | | | | |
| [mregion#5] | No useReadReplica()/preferReadReplica() shortcut exists (negative claim) | B | | | | | |
| [mregion#6] | Doctor replica_lag: pg_is_in_recovery() + pg_last_xact_replay_timestamp(); issue codes replica_not_in_recovery/replica_lag_high/replica_lag_critical/replica_unreachable; 30s/120s defaults | B | | | | | |
| [mregion#7] | replica_unreachable includes pg error code but drops raw error text (no DSN/password leak) | B | | | | | |
| [mregion#8] | No automatic failover: resolve() returns connection even for unreachable replica; query throws ECONNREFUSED | A | | | | | |
| [mregion#9] | Prometheus metric `multitenancy_replica_lag_seconds` exists | B | | | | | |
| [mregion#10] | Writes always go to the primary configured on the template connection | B | | | | | |
| [mregion#11] | `pickIndex()` named as the routing primitive apps wrap for pinning | B | | | | | |

---

_Total rows: 972 seeded + 101 re-sweep = 1073._

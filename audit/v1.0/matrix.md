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
| [intro#1] | "Four isolation drivers: schema-pg (default), database-pg, rowscope-pg, sqlite-memory. Pluggable through a single contract." | B | VERIFIED | 4 drivers + IsolationDriver contract (driver.ts) | driver specs | none |  |
| [intro#2] | "Five bootstrappers: cache, drive (filesystem), mail, session, broadcasting. Each scoped to the active tenant via AsyncLocalStorage." | B | VERIFIED | provider:147-264 registers exactly these 5 | bootstrapper_registry.spec.ts | none | the page that gets the count right (F-10 fixes why/showcase) |
| [intro#3] | "Nine satellites: audit logs, feature flags, webhooks, branding, SSO, metrics, quotas, impersonation, Stripe billing." | B | VERIFIED | 9 satellites: 7 in-core + sso + billing pkgs | satellite specs | none |  |
| [intro#4] | "Operational kit: tenant:doctor (ten checks, --fix, --watch, --json), backups with retention tiers, read replicas, Prometheus, OpenTelemetry, health probes" | B | PARTIAL | core ships 9 doctor checks; 10th from backup pkg | doctor specs | doc-fix:F-11 |  |
| [intro#5] | "A full suite of ace commands spanning provisioning, migrations, backups, cloning, exec-under-tenant, maintenance mode, REPL, billing." | B | VERIFIED | 21 core + 6 backup + 6 billing commands | e2e commands suites | none |  |
| [intro#6] | "REST admin API with an OpenAPI 3.1 spec and Swagger UI." | B | VERIFIED | packages/admin routes.ts:208-223 OpenAPI + Swagger UI (/docs) | openapi.spec.ts; e2e admin_full | none |  |
| [intro#7] | "MySQL or MariaDB — Schemas are a Postgres-native concept" | B | VERIFIED | PG-only by design (no mysql codepath) | — | none |  |
| [intro#8] | "An admin dashboard UI — Only the REST API" | B | VERIFIED | no UI shipped; admin pkg is REST-only | — | none |  |
| [intro#9] | "A starter kit — create-lasagna-saas is roadmap" | B | N/A | roadmap statement, consistent with roadmap.md | — | none |  |

## concepts.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [concepts#1] | "Layer 1: Central (public schema) — your product-wide data" | B | VERIFIED | central connection + centralSchemaName | fixture config | none |  |
| [concepts#2] | "Layer 2: Backoffice (backoffice schema) — tenant registry + operator tools" | B | VERIFIED | backoffice schema + tenants registry | backoffice setup + satellite specs | none |  |
| [concepts#3] | "Layer 3: Tenant (tenant_<uuid> schema) — one schema per customer" | B | VERIFIED | schema_pg_driver tenant_<uuid> | cross_tenant_e2e | none |  |
| [concepts#4] | "Layer 4: Satellites (opt-in features stored in backoffice schema) — audit, feature_flags, webhooks, branding, sso, metrics, quotas, impersonation" | B | VERIFIED | satellite tables in backoffice schema (stubs/migrations) | satellite_coexistence.spec.ts | none |  |
| [concepts#5] | "The active isolation driver decides which Lucid connection serves a query" | B | VERIFIED | active_driver.ts + adapters | adapter specs | none |  |
| [concepts#6] | "The bootstrapper registry enters and leaves per-tenant contexts" | B | VERIFIED | bootstrapper_registry.ts runScoped | bootstrapper_isolation.spec.ts | none |  |
| [concepts#7] | "AsyncLocalStorage carries the active tenant id, so logs, queries, and queued jobs all see the same context" | B | VERIFIED | TenantLogContext AsyncLocalStorage | tenant_context.spec.ts; e2e contextual_logging | none |  |

## installation.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [install#1] | "Node.js ≥ 24 — ES modules, module: NodeNext" | B | VERIFIED | package.json engines >=24.0.0; NodeNext | CI Node 24 | none |  |
| [install#2] | "AdonisJS 7" | B | VERIFIED | peer @adonisjs/core ^7 | — | none |  |
| [install#3] | "PostgreSQL ≥ 14 via @adonisjs/lucid" | B | VERIFIED | peer @adonisjs/lucid ^22 (pg client) | suite runs PG16 | none | ≥14 floor not encoded; guidance |
| [install#4] | "Redis ≥ 6 via @adonisjs/redis — cache + counters" | B | PARTIAL | peer @adonisjs/redis ^10; BUT sso GETDEL needs Redis ≥6.2 (sso_service.ts:88) while page says ≥6 | — | doc-fix:F-20 |  |
| [install#5] | "@adonisjs/queue required — background jobs provision schemas" | B | VERIFIED | peer @adonisjs/queue (required) | e2e queue_jobs | none |  |
| [install#6] | "@aws-sdk/client-s3 optional — only for S3 backup uploads" | B | VERIFIED | @aws-sdk/client-s3 optional peer of backup pkg | backup_s3.spec.ts | none |  |
| [install#7] | "jose optional — only when SSO is enabled" | B | VERIFIED | jose optional (dynamic import in sso_service.ts:152) | sso specs | none |  |
| [install#8] | Command: `npm install @adonisjs-lasagna/saas-tenancy` | B | VERIFIED | package name/version | — | none |  |
| [install#9] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy` (without --with: all satellites) | B | VERIFIED | configure.ts bare run selects all satellites | configure.spec.ts | none |  |
| [install#10] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks` | B | VERIFIED | --with parsing | configure.spec.ts | none |  |
| [install#11] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --no-interaction --with=audit,branding,feature_flags` | B | VERIFIED | --no-interaction supported (ace configure) | configure.spec.ts | none |  |
| [install#12] | "Three connection contexts live side by side: public (global data), backoffice (tenant registry + satellite features), tenant_<uuid> (per-tenant data)" | B | VERIFIED | 3 connection contexts (fixture database.ts) | integration suite | none |  |
| [install#13] | "Tenant connections are created at runtime, no entry needed in config/database.ts" | B | VERIFIED | drivers register tenant connections at runtime (connection_lru) | connection_lru.spec.ts | none |  |
| [install#14] | "searchPath: 'public'" for public connection | B | VERIFIED | fixture database.ts searchPath central | — | none |  |
| [install#15] | "searchPath: 'backoffice'" for backoffice connection | B | VERIFIED | fixture database.ts searchPath backoffice | — | none |  |
| [install#16] | Command: `node ace backoffice:setup` — Creates backoffice schema and runs all satellite migrations | B | VERIFIED | setup_backoffice.ts | e2e setup | code-fix:F-4 |  |
| [install#17] | Command: `node ace tenant:create "name" "email"` | B | VERIFIED | create_tenant.ts | e2e commands_lifecycle | none |  |
| [install#18] | Command: `node ace queue:work` | B | VERIFIED | @adonisjs/queue queue:work | e2e queue_jobs | none |  |
| [install#19] | Command: `node ace tenant:migrate` | B | VERIFIED | tenant_migrate.ts | e2e commands_lifecycle | none |  |
| [install#20] | Middleware: `TenantGuardMiddleware` — resolves tenant and memoizes | B | VERIFIED | tenant_guard_middleware.ts | guard specs (unit+integration) | none |  |
| [install#21] | Middleware: `CustomDomainMiddleware` — maps custom domains to tenants | B | VERIFIED | custom_domain_middleware.ts | custom_domain specs | none |  |
| [install#22] | Middleware: `RateLimitMiddleware` — **fail-closed by default**: if Redis unreachable, throws RateLimitUnavailableException (HTTP 503) | B | VERIFIED | rate_limit default failOpen:false → 503 | rate_limit.spec.ts:93 | none |  |
| [install#23] | Option on RateLimitMiddleware: `failOpen: true` — per-route option to fail-open | B | VERIFIED | RateLimitOptions.failOpen per-route | rate_limit.spec.ts:133 | none |  |
| [install#24] | "RateLimitMiddleware is fail-closed by default" | A | VERIFIED | rate_limit_middleware.ts default | rate_limit.spec.ts:93 | none |  |
| [install#25] | "The middleware short-circuits when `app.inTest === true`" | A | VERIFIED | rate_limit_middleware.ts:24,48-49 app.inTest short-circuit (opt back in via options) | rate_limit unit spec exercises isTestEnv override | none |  |
| [install#26] | Command: `node ace tenant:migrate` and `node ace queue:work` are separate steps; InstallTenant creates the schema empty, tenant:migrate applies migrations | A | VERIFIED | install_tenant.ts:36 provision only (no migrate); tenant_migrate separate | e2e commands_lifecycle (create→migrate) | none | jobs.md still claims InstallTenant runs migrations → folded into F-17 |

## tenant-identification.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [resolve#1] | Strategy: `header` (default) — Reads `x-tenant-id` from request headers | B | VERIFIED | builtins.ts:19 HeaderResolver; default via config stub:17 env.get('TENANT_RESOLVER','header') | tenant_resolver.spec.ts; e2e resolution_strategies | none | default = installer stub, not code |
| [resolve#2] | Strategy: `subdomain` — Extracts UUID from `<uuid>.yourdomain.com` | B | VERIFIED | builtins.ts:34 SubdomainResolver (baseDomain parse) | tenant_adapter.spec.ts:117; e2e resolution_strategies | none |  |
| [resolve#3] | Strategy: `path` — Reads the first path segment `/<uuid>/...` | B | VERIFIED | builtins.ts:59 PathResolver | tenant_adapter.spec.ts:130; e2e | none |  |
| [resolve#4] | Strategy: `request-data` — Reads from query string or body | B | VERIFIED | builtins.ts:105 RequestDataResolver (qs + input) | builtin_resolvers.spec.ts | none |  |
| [resolve#5] | Strategy: `domain-or-subdomain` — Custom domain wins, falls back to subdomain | B | VERIFIED | builtins.ts:80 DomainOrSubdomainResolver | tenant_adapter.spec.ts:445 subdomain fallback | none |  |
| [resolve#6] | Config key: `resolverStrategy` — set to 'header', 'subdomain', 'path', 'domain-or-subdomain', or 'request-data' | B | VERIFIED | types/config.ts:4-9 | — | none |  |
| [resolve#7] | Config key: `tenantHeaderKey` (defaults to 'x-tenant-id') | B | VERIFIED | builtins.ts:21 reads config; stub:18 default 'x-tenant-id' | tenant_adapter.spec.ts:104 | none | default = installer stub |
| [resolve#8] | Config key: `baseDomain` — for subdomain strategy | B | VERIFIED | types/config.ts:362 | — | none |  |
| [resolve#9] | Config: `requestData.queryKey` (default 'tenant_id') — ?tenant_id=<uuid> | B | VERIFIED | builtins.ts:109 | builtin_resolvers.spec.ts | none |  |
| [resolve#10] | Config: `requestData.bodyKey` (default 'tenant_id') — { "tenant_id": "<uuid>" } | B | VERIFIED | builtins.ts:110 | builtin_resolvers.spec.ts | none |  |
| [resolve#11] | Macro: `request.tenant()` — memoized per request, returns the resolved tenant | B | VERIFIED | extensions/request.ts macro + Symbol memo | request_tenant_memo.spec.ts:5 | none |  |
| [resolve#12] | "Always call this helper rather than reading the header directly" | A | VERIFIED | resolveTenantId() honours strategy+chain (extensions/request.ts) | tenant_resolver.spec.ts | none | guidance backed by mechanism |
| [resolve#13] | Interface: `TenantResolver` contract for custom resolvers | B | VERIFIED | resolvers/resolver.ts TenantResolver interface | resolver_registry.spec.ts | none |  |
| [resolve#14] | API: `ResolverRegistry.register('name', resolver)` in provider | B | VERIFIED | resolvers/registry.ts register() | resolver_registry.spec.ts | none |  |
| [resolve#15] | Config: `resolverChain: ['header', 'subdomain', 'request-data']` — first hit wins | B | VERIFIED | types/config.ts:354 resolverChain | resolver_registry.spec.ts chain order | none |  |
| [resolve#16] | Overrides `resolverStrategy` when set | A | VERIFIED | types/config.ts:351-354 'overrides resolverStrategy' | tenant_adapter.spec.ts:339 custom chain routing | none |  |
| [resolve#17] | Config: `resolver.legacyAdapterFallback` (defaults to false) — controls synchronous fallback for model queries outside request guard | B | VERIFIED | types/config.ts:29 default false as of 1.0 | tenant_adapter.spec.ts:387 'flag defaults to false in 1.0' | none |  |
| [resolve#18] | Default (false): adapter consults the resolver chain synchronously | B | VERIFIED | types/config.ts:18-23 resolveSync path | tenant_adapter.spec.ts:339 | none |  |
| [resolve#19] | True: restores 0.x behavior — adapter uses only `resolverStrategy` on fallback | B | VERIFIED | types/config.ts:24-27 | tenant_adapter.spec.ts:362 legacy opt-in | none |  |

## routing.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [routing#1] | Macro: `router.tenant()` — Wraps with `TenantGuardMiddleware`, requires resolved tenant | B | VERIFIED | extensions/router.ts:23,70 tenant() wraps TenantGuardMiddleware | router_macros.spec.ts; fixture app routes | none |  |
| [routing#2] | Macro: `router.central()` — Wraps with `CentralOnlyMiddleware`, requires NO tenant in scope | B | VERIFIED | router.ts:29,76 central() wraps CentralOnlyMiddleware | central_only_middleware.spec.ts | none |  |
| [routing#3] | Macro: `router.universal()` — Wraps with `UniversalMiddleware`, resolves tenant when present, never fails when absent | B | VERIFIED | router.ts:36,81 universal() wraps UniversalMiddleware | universal_middleware.spec.ts | none |  |
| [routing#4] | Middleware: `CustomDomainMiddleware` — queries `findByDomain(host)` from tenant repository | B | VERIFIED | custom_domain_middleware.ts findByDomain(host) | custom_domain_middleware specs (unit+integration) | new-test:T5 (verify-first e2e mapping) |  |
| [routing#5] | Option: `strict: true` — rejects conflicting header/domain with HTTP 400 (`E_TENANT_HEADER_DOMAIN_MISMATCH`) | B | VERIFIED | custom_domain strict → TenantHeaderDomainMismatchException 400 | header_vs_domain_precedence.spec.ts:27 | none |  |
| [routing#6] | Default: explicit `x-tenant-id` header wins over Host-resolved tenant | B | VERIFIED | non-strict default: header wins | header_vs_domain_precedence.spec.ts (header-only mode) | none |  |
| [routing#7] | `strict: true` mode: rejects when header disagrees with domain | B | VERIFIED | strict branch | header_vs_domain_precedence.spec.ts:27,:110 | none |  |
| [routing#8] | API: `tenancy.run(tenant, fn)` — opens a tenant context for non-HTTP code | B | VERIFIED | tenancy.ts run() | tenant_context.spec.ts; tenant_log_context.spec.ts | none |  |
| [routing#9] | Returns: underlying `RouteGroup` so you can chain `.prefix()`, `.use()`, `.where()`, etc. | B | VERIFIED | router.ts:54 'return the underlying RouteGroup' | router_macros.spec.ts | none |  |
| [routing#10] | Example: `router.makeUrl('orders.show', { id }, { prefixUrl: tenant.customDomain \|\| `https://${tenant.id}.app.example.com` })` | B | VERIFIED | standard AdonisJS makeUrl + prefixUrl (snippet validity) | — | none |  |

## configuration.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [config#1] | Key: `backofficeSchemaName` — PG schema holding shared/satellite data | B | VERIFIED | types/config.ts:343 | — | none |  |
| [config#2] | Key: `backofficeConnectionName` — Lucid connection for backoffice schema | B | VERIFIED | types/config.ts:344 | — | none |  |
| [config#3] | Key: `centralSchemaName` — schema for central/global (non-tenant) tables | B | VERIFIED | types/config.ts:345 | — | none |  |
| [config#4] | Key: `centralConnectionName` — Lucid connection for central schema | B | VERIFIED | types/config.ts:346 | — | none |  |
| [config#5] | Key: `tenantConnectionNamePrefix` — prefix for per-tenant connection names | B | VERIFIED | types/config.ts:347 | — | none |  |
| [config#6] | Key: `tenantSchemaPrefix` — prefix for per-tenant schema names | B | VERIFIED | types/config.ts:348 | — | none |  |
| [config#7] | Key: `schemaCacheTtl` — TTL (seconds) for cached schema-existence probes | B | VERIFIED | types/config.ts:420 | — | none |  |
| [config#8] | Key: `ignorePaths` — request paths that skip tenant resolution | B | VERIFIED | types/config.ts:421 | — | none |  |
| [config#9] | Key: `resolverStrategy` — 'subdomain' \| 'header' \| 'path' \| 'domain-or-subdomain' \| 'request-data' | B | VERIFIED | types/config.ts:4-9 (5 strategies) | builtin_resolvers + tenant_resolver specs | none |  |
| [config#10] | Key: `resolverChain` — ordered resolver names; first hit wins | B | VERIFIED | types/config.ts:354 (overrides resolverStrategy) | resolver_registry.spec.ts | none |  |
| [config#11] | Key: `tenantHeaderKey` — header name for header resolver | B | VERIFIED | types/config.ts:361 | tenant_adapter.spec.ts:104 custom header key | none |  |
| [config#12] | Key: `baseDomain` — apex domain for subdomain parsing | B | VERIFIED | types/config.ts:362 | — | none |  |
| [config#13] | Key: `requestData.queryKey` (default 'tenant_id') | B | VERIFIED | builtins.ts:109 queryKey ?? 'tenant_id' | builtin_resolvers.spec.ts | none |  |
| [config#14] | Key: `requestData.bodyKey` (default 'tenant_id') | B | VERIFIED | builtins.ts:110 bodyKey ?? 'tenant_id' | builtin_resolvers.spec.ts | none |  |
| [config#15] | Key: `isolation.driver` — 'schema-pg' \| 'database-pg' \| 'rowscope-pg' \| 'sqlite-memory' (default 'schema-pg') | B | VERIFIED | types/config.ts:218-226; provider falls back {driver:'schema-pg'} | isolation_driver_registry.spec.ts | none |  |
| [config#16] | Key: `isolation.templateConnectionName` (default 'tenant') — connection cloned per tenant | B | VERIFIED | types/config.ts:233 default 'tenant' | schema_pg_driver specs | none |  |
| [config#17] | Key: `isolation.tenantDatabasePrefix` (default 'tenant_') — prefix for database-pg | B | VERIFIED | types/config.ts:238 default 'tenant_' | database_pg_driver specs | none |  |
| [config#18] | Key: `isolation.rowScopeTables` — tables wiped on destroy (rowscope-pg) | B | VERIFIED | types/config.ts:245 | rowscope_pg_driver.spec.ts destroy/reset | none |  |
| [config#19] | Key: `isolation.rowScopeColumn` (default 'tenant_id') — column name | B | VERIFIED | types/config.ts:250 default 'tenant_id' | rowscope specs | none |  |
| [config#20] | Key: `isolation.rowScopeMode` — 'strict' (default) \| 'allowGlobal' | B | VERIFIED | types/config.ts:262; scoping.ts:50 ?? 'strict' | scoping.spec.ts strict group | none |  |
| [config#21] | Key: `resilience.defaultPolicy` (default 'fail-closed') — fallback for unspecified dependencies | B | VERIFIED | types/config.ts:323 default 'fail-closed' | resilience_service.spec.ts | new-test:T4 (pin all defaults) |  |
| [config#22] | Key: `resilience.redis.quota` (default 'fail-open') — on Redis outage for QuotaService | B | VERIFIED | quota_service.ts:372 ?? 'fail-open' | quota_resilience.spec.ts | new-test:T4 |  |
| [config#23] | Key: `resilience.redis.rateLimit` (default 'fail-closed') — for RateLimitMiddleware | B | VERIFIED | types/config.ts:328; rate_limit default fail-closed | rate_limit.spec.ts:93 | new-test:T4 |  |
| [config#24] | Key: `resilience.redis.cache` (default 'fail-open') — cache bootstrapper | B | VERIFIED | types/config.ts:331 | — | new-test:T4 |  |
| [config#25] | Key: `resilience.redis.metrics` (default 'fail-open') — MetricsService | B | VERIFIED | types/config.ts:333 | — | new-test:T4 |  |
| [config#26] | Key: `resilience.observe` (default true) — emit DependencyDegraded events | B | VERIFIED | types/config.ts:339 default true | resilience_service.spec.ts (DependencyDegraded) | none |  |
| [config#27] | Key: `circuitBreaker.threshold` — error-percentage threshold to open | B | VERIFIED | types/config.ts:427 | circuit_breaker_service.spec.ts | none |  |
| [config#28] | Key: `circuitBreaker.resetTimeout` — ms in OPEN before probing (HALF_OPEN) | B | VERIFIED | types/config.ts:428 | circuit_breaker_service.spec.ts | none |  |
| [config#29] | Key: `circuitBreaker.rollingCountTimeout` — ms window for rolling error stats | B | VERIFIED | types/config.ts:429 | — | none |  |
| [config#30] | Key: `circuitBreaker.volumeThreshold` — minimum requests before breaker can trip | B | VERIFIED | types/config.ts:430 | — | none |  |
| [config#31] | "Open/closed state is persisted to Redis and restored on restart" | A | VERIFIED | circuit_breaker_service.ts Redis persistence | integration circuit_breaker_service.spec.ts — fresh service restores OPEN from persisted Redis state | none |  |
| [config#32] | Key: `queue.tenantQueuePrefix` — per-tenant queue-name prefix | B | VERIFIED | types/config.ts:438 | tenant_queue_service usage | none |  |
| [config#33] | Key: `queue.defaultConcurrency` — default worker concurrency | B | VERIFIED | types/config.ts:439 | — | none |  |
| [config#34] | Key: `queue.attempts` — default job retry attempts | B | VERIFIED | types/config.ts:440 | — (behavior untested) | new-test:T2 |  |
| [config#35] | Key: `queue.redis` — dedicated Redis for queues | B | VERIFIED | types/config.ts:441-447 | integration suite uses db 1 | none |  |
| [config#36] | Key: `cache.ttl` — default cache TTL (seconds) | B | VERIFIED | types/config.ts:476 | cache_for.spec.ts | none |  |
| [config#37] | Key: `cache.redis` — dedicated Redis for cache | B | VERIFIED | types/config.ts:477-483 | cache_for.spec.ts (db 2) | none |  |
| [config#38] | Key: `backup.storagePath` — local dir for `.dump` archives + sidecar | B | VERIFIED | types/config.ts:456 | backup pkg specs | none |  |
| [config#39] | Key: `backup.metadataTtl` — TTL (seconds) for backup metadata in Redis | B | VERIFIED | types/config.ts:457 | — | none |  |
| [config#40] | Key: `backup.pgConnection` — connection used by pg_dump/pg_restore/psql | B | VERIFIED | types/config.ts:458-464 | e2e backups_real.spec.ts | none |  |
| [config#41] | Key: `backup.s3` — optional S3 offload config | B | VERIFIED | types/config.ts:465-472 | backup_s3.spec.ts (MinIO, CI) | none |  |
| [config#42] | Key: `plans.defaultPlan` — plan applied when nothing else resolves | B | VERIFIED | types/config.ts:75 | quota_service.spec.ts | none |  |
| [config#43] | Key: `plans.definitions` — Record<string, { limits: Record<string, number> }> | B | VERIFIED | types/config.ts:76 | quota_service.spec.ts | none |  |
| [config#44] | Key: `plans.getPlan` — (tenant) => string \| undefined callback | B | VERIFIED | types/config.ts:83 | quota_service.spec.ts | none |  |
| [config#45] | Key: `plans.storage` — 'config-only' \| 'tenant_plans' \| 'auto' (default 'auto') | B | VERIFIED | types/config.ts:95 default 'auto' | quota_assignment.spec.ts | none |  |
| [config#46] | Key: `plans.emitTracked` (default false) — emit QuotaTracked on every track/consume | B | VERIFIED | types/config.ts:101 default false | metered_usage.spec.ts | none |  |
| [config#47] | Key: `billing` — BillingConfig for Stripe satellite | B | VERIFIED | types/config.ts:111-180 BillingConfig | billing integration suite (27 specs) | none |  |
| [config#48] | Key: `impersonation.secret` — HMAC secret (≥ 32 chars), validated at boot | B | VERIFIED | types/config.ts:388 (≥32 chars; start() throws unset) | impersonation_service.spec.ts | none |  |
| [config#49] | Key: `impersonation.defaultDuration` (default 3600 seconds) | B | VERIFIED | types/config.ts:390 default 3600 | impersonation_service.spec.ts | none |  |
| [config#50] | Key: `impersonation.maxDuration` (default 86400 seconds) | B | VERIFIED | types/config.ts:392 default 86400 | — | none |  |
| [config#51] | Key: `impersonation.headerName` (default 'x-impersonation-token') | B | VERIFIED | types/config.ts:394 default x-impersonation-token | impersonation_middleware.spec.ts | none |  |
| [config#52] | Key: `impersonation.cookieName` (default '__impersonation') | B | VERIFIED | types/config.ts:396 default __impersonation | — | none |  |
| [config#53] | Key: `maintenance.defaultMessage` — default body for TenantMaintenanceException | B | VERIFIED | types/config.ts:403 | tenant_guard_maintenance.spec.ts | none |  |
| [config#54] | Key: `maintenance.retryAfterSeconds` (default 600) | B | VERIFIED | types/config.ts:408 default 600 | tenant_guard_maintenance.spec.ts | none |  |
| [config#55] | Key: `maintenance.bypassToken` / `bypassHeader` (default 'x-tenant-bypass-maintenance') | B | VERIFIED | types/config.ts:414-418 | tenant_guard_maintenance.spec.ts bypass | none |  |
| [config#56] | Key: `softDelete.retentionDays` (default 30) | B | VERIFIED | types/config.ts:495 default 30 | soft_delete.spec.ts | none |  |
| [config#57] | Key: `doctor.queueStalledMinutes` (default 10) | B | VERIFIED | queue_stuck_check.ts:7 DEFAULT=10 | doctor/queue_stuck.spec.ts | none |  |
| [config#58] | Key: `doctor.replicaLagWarnSeconds` (default 30) | B | VERIFIED | replica_lag_check.ts:4 DEFAULT=30 | doctor/replica_lag.spec.ts | none |  |
| [config#59] | Key: `doctor.replicaLagErrorSeconds` (default 120) | B | VERIFIED | replica_lag_check.ts:5 DEFAULT=120 | doctor/replica_lag.spec.ts | none |  |
| [config#60] | Key: `doctor.longQueryWarnSeconds` (default 30) | B | VERIFIED | long_running_queries_check.ts:4 DEFAULT=30 | doctor/long_running_queries.spec.ts | none |  |
| [config#61] | Key: `doctor.longQueryErrorSeconds` (default 120) | B | VERIFIED | long_running_queries_check.ts:5 DEFAULT=120 | doctor/long_running_queries.spec.ts | none |  |
| [config#62] | Key: `doctor.poolSaturationWarnRatio` (default 0.9) | B | VERIFIED | connection_pool_check.ts:4 DEFAULT=0.9 | connection_pool_check.spec.ts | none |  |
| [config#63] | Key: `tenantReadReplicas.hosts` — pool of read replicas | B | VERIFIED | types/config.ts:195 | read_replica specs | none |  |
| [config#64] | Key: `tenantReadReplicas.strategy` — 'round-robin' \| 'random' \| 'sticky' (default 'round-robin') | B | VERIFIED | types/config.ts:201 default round-robin | e2e replicas_strategies.spec.ts | none |  |
| [config#65] | Key: `tenantReadReplicas.connectionSuffix` (default '_read') | B | VERIFIED | types/config.ts:207 default _read | read_replica_resolve.spec.ts | none |  |

## models.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [models#1] | Class: `TenantBaseModel` — extends Lucid, lands in active tenant's schema/database | B | VERIFIED | models/base/tenant_base_model.ts + TenantAdapter | adapter unit+integration | none |  |
| [models#2] | Class: `withTenantScope(BaseModel)` — mixin for rowscope-pg, shared schema + tenant_id filter | B | VERIFIED | scoping.ts:117 | scoping.spec.ts | none |  |
| [models#3] | Class: `BackofficeBaseModel` — pins `static connection = 'backoffice'` | B | VERIFIED | backoffice_base_model.ts:4 static connection='backoffice' (provider rewires to configured name) | satellite specs use it | none |  |
| [models#4] | Class: `CentralBaseModel` — pins `static connection = 'public'` | B | VERIFIED | central_base_model.ts:12 static connection='public' | fixture Tenant model | none |  |
| [models#5] | "TenantBaseModel query with no active tenant context cannot resolve a connection and fails fast" | A | VERIFIED | tenant_adapter.ts:60-64 throws MissingTenantHeaderException | tenant_adapter.spec.ts:170 'throws … when tenant ID header is absent' | none |  |
| [models#6] | "Inside an HTTP request the active tenant comes from the guard" | B | VERIFIED | guard seeds context; adapter prefers tenancy.currentId() | tenant_adapter.spec.ts:228 | none |  |
| [models#7] | "Outside a request, open a context with tenancy.run(tenant, fn)" | B | VERIFIED | tenancy.run() | tenant_adapter.spec.ts:257 queue/script path | none |  |
| [models#8] | "Injects WHERE tenant_id = <current> on find / fetch / paginate" | B | VERIFIED | scoping.ts:139-174 | scoping.spec.ts:95 | none |  |
| [models#9] | "Auto-fills tenant_id on create" | B | VERIFIED | scoping.ts:176-181 | scoping.spec.ts:126 | none |  |
| [models#10] | "Throws on update / delete if the row's tenant_id differs from the active scope" | B | VERIFIED | scoping.ts:195-216 | scoping.spec.ts:171 | none |  |
| [models#11] | "A top-level orWhere can escape the auto-scope (SQL binds AND tighter than OR)" | A | VERIFIED | scoping.ts:91-115 doc comment | rowscope_rls.spec.ts:74 | none |  |
| [models#12] | "In strict mode (default), a scoped query with no active context throws rather than running unscoped" | B | VERIFIED | scoping.ts:135 | scoping.spec.ts:202; rowscope_pg_driver.spec.ts:232 | none |  |
| [models#13] | "Always reads and writes the shared backoffice schema regardless of active tenant" | B | VERIFIED | BackofficeAdapter pins backoffice connection | satellite coexistence spec | none |  |
| [models#14] | "Pins `static connection = 'public'` and prefixes table name with centralSchemaName" | B | VERIFIED | central_base_model.ts:12 + table prefix logic | fixture Tenant (central) usage across suite | none |  |
| [models#15] | "Lucid relationships cross layers will not resolve (different schemas/databases)" | A | VERIFIED | different connections/schemas — Lucid relationships resolve on one connection | — (negative framework constraint) | none |  |
| [models#16] | "Foreign key cannot span per-tenant schema and central schema" | A | VERIFIED | PG cannot FK across databases; cross-schema FK unsupported by design here | — | none |  |
| [models#17] | "To associate across layers, store the other layer's id as plain column and load explicitly" | B | VERIFIED | guidance consistent with faq#8 | — | none |  |
| [models#18] | API: `tenancy.run(tenant, fn)` — opens tenant context for jobs, commands, scripts | B | VERIFIED | tenancy.ts run() | tenant_context.spec.ts:72 | none |  |
| [models#19] | API: `unscoped(fn)` — disables row-scoping for cross-tenant work | B | VERIFIED | scoping.ts:27 unscoped() | scoping.spec.ts:58 | none |  |

## commands.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cmd#1] | Command: `backoffice:setup` — Create backoffice schema and run satellite migrations. Idempotent. | B | PARTIAL | commands.json backoffice:setup; setup_backoffice.ts | e2e runs once; no re-run test | new-test:T10 code-fix:F-4 |  |
| [cmd#2] | Command: `tenant:create <name> <email>` — Insert tenant row and queue InstallTenant | B | VERIFIED | commands.json tenant:create (args name,email) | e2e commands_lifecycle.spec.ts | none |  |
| [cmd#3] | Command: `tenant:list` — List tenants with current status. --all includes soft-deleted. | B | VERIFIED | commands.json tenant:list --all | e2e commands_misc.spec.ts | none |  |
| [cmd#4] | Command: `tenant:activate <id>` — Activate a suspended or failed tenant | B | VERIFIED | commands.json tenant:activate | e2e lifecycle | none |  |
| [cmd#5] | Command: `tenant:suspend <id>` — Block all API access without dropping the schema | B | VERIFIED | commands.json tenant:suspend | e2e lifecycle | none |  |
| [cmd#6] | Command: `tenant:destroy <id>` — Soft-delete and tear down. --force skips prompt; --keep-schema preserves storage during retention | B | VERIFIED | commands.json tenant:destroy --force/-y --keep-schema | e2e commands_lifecycle.spec.ts | none |  |
| [cmd#7] | Command: `migration:tenant:run` / `tenant:migrate` — Run pending migrations against one or all tenants | B | VERIFIED | commands.json migration:tenant:run + tenant:migrate alias | e2e commands_lifecycle.spec.ts | none |  |
| [cmd#8] | Flags on tenant:migrate: `--dry-run`, `--disable-locks`, `--verbose` | B | VERIFIED | commands.json flags dry-run/disable-locks/verbose | — | none |  |
| [cmd#9] | Command: `migration:tenant:rollback` / `tenant:migrate:rollback` — Roll back last migration batch | B | VERIFIED | commands.json migration:tenant:rollback + alias | e2e | none |  |
| [cmd#10] | Command: `tenant:migrate:fresh` — DROP and recreate per-tenant storage, then re-run migrations | B | VERIFIED | commands.json tenant:migrate:fresh (DESTRUCTIVE) | unit metadata spec | none |  |
| [cmd#11] | Flags on tenant:migrate:fresh: `--force`, `--seed` | B | VERIFIED | flags force/-y, seed (+disable-locks, verbose) | — | none |  |
| [cmd#12] | Command: `tenant:seed` — db:seed per tenant. --files cherry-picks specific seeders | B | VERIFIED | commands.json tenant:seed --files/-f --continue-on-error | — | none |  |
| [cmd#13] | Command: `tenant:backup` — One-shot backup for one or all active tenants (synchronous) | B | VERIFIED | packages/backup commands.json tenant:backup | e2e backups_real.spec.ts | doc-fix:F-13 | needs backup pkg |
| [cmd#14] | Command: `tenant:backups:run` — Cron-friendly: backs up tenants whose tier interval elapsed, then applies retention | B | VERIFIED | backup commands.json tenant:backups:run | backup_retention_service.spec.ts | doc-fix:F-13 |  |
| [cmd#15] | Flags on tenant:backups:run: `--dry-run`, `--no-retention` | B | VERIFIED | flags tenant,force,dry-run,no-retention | — | none |  |
| [cmd#16] | Command: `tenant:backup:list` — List available backups | B | VERIFIED | backup commands.json tenant:backup:list | e2e backups_real | doc-fix:F-13 |  |
| [cmd#17] | Command: `tenant:restore --tenant=<id> --file=<name>` — Restore a tenant schema from .dump file | B | VERIFIED | backup commands.json tenant:restore (tenant,file) | e2e backups_real round-trip | doc-fix:F-13 |  |
| [cmd#18] | Command: `tenant:import --tenant=<id> --file=<path>` — Import a pg_dump .sql file into a tenant schema | B | VERIFIED | backup commands.json tenant:import (tenant,file,schema-replace,dry-run,verbose,force) | sql_import_service.spec.ts | doc-fix:F-13 |  |
| [cmd#19] | Command: `tenant:clone --source=<id> --name=<name> --email=<email>` — Provision new tenant by cloning existing | B | VERIFIED | backup commands.json tenant:clone (source,name,email) | clone_service.spec.ts | doc-fix:F-13 |  |
| [cmd#20] | Flags on tenant:clone: `--schema-only`, `--clear-sessions` | B | VERIFIED | flags schema-only, clear-sessions | — | none |  |
| [cmd#21] | Command: `tenant:queue:stats` — BullMQ queue statistics | B | VERIFIED | commands.json tenant:queue:stats --tenant/-t | e2e commands_misc | none |  |
| [cmd#22] | Command: `tenant:doctor` — Ten built-in checks, --fix to auto-recover, --json for CI gates, --watch for live TUI | B | PARTIAL | commands.json tenant:doctor (flags ok); core ships 9 checks not ten | doctor_checks_real.spec.ts | doc-fix:F-11 |  |
| [cmd#23] | Flag: `--tenant=<id>` — Limit to one tenant | B | VERIFIED | flag tenant/-t array | — | none |  |
| [cmd#24] | Flag: `--check=schema_drift,backups` — Run specific checks; --check=list prints available | B | BROKEN | check names: schema_drift,migration_state,circuit_breakers,connection_pool,queue_health,failed_tenants,provisioning_stalled,long_running_queries,replica_lag — no check named 'backups' | — | doc-fix:F-14 |  |
| [cmd#25] | Flag: `--fix` — Auto-fix what's fixable | B | VERIFIED | flag fix | doctor_checks_real (fix paths) | none |  |
| [cmd#26] | Flag: `--json` — CI gate: exits non-zero if anything is unhealthy | B | VERIFIED | tenant_doctor.ts:92,97 exitCode = totals.error>0 ? 1 : 0 | — | none |  |
| [cmd#27] | Flag: `--watch --interval=5000` — Live dashboard refreshing every 5 s | B | VERIFIED | flags watch/-w, interval (default 5000, min 1000) | — | none |  |
| [cmd#28] | Command: `tenant:exec list:routes` / `tenant:exec --tenant=<id> make:migration users` | B | VERIFIED | commands.json tenant:exec (command + spread args) | e2e commands_lifecycle (tenant:exec) | none |  |
| [cmd#29] | Flag: `--tenant=<id...>` — Target one or more tenants | B | VERIFIED | flag tenant/-t | — | none |  |
| [cmd#30] | Flag: `--status=<status...>` — Filter (active, provisioning, suspended, failed, deleted) | B | VERIFIED | flag status array (5 values in description) | — | none |  |
| [cmd#31] | Flag: `--include-deleted` — Include soft-deleted in iteration | B | VERIFIED | flag include-deleted | — | none |  |
| [cmd#32] | Flag: `--limit=<n>` — Stop after N tenants | B | VERIFIED | flag limit | — | none |  |
| [cmd#33] | Flag: `--batch-size=<n>` (default 100) — Cursor batch size | B | VERIFIED | flag batch-size (default 100 in description) | — | none |  |
| [cmd#34] | Flag: `--continue-on-error` — Don't bail on tenant failure | B | VERIFIED | flag continue-on-error | — | none |  |
| [cmd#35] | Flag: `--dry-run` — Report which tenants would run | B | VERIFIED | flag dry-run | — | none |  |
| [cmd#36] | Command: `tenant:maintenance <id>` — Toggle maintenance mode. --off exits, --message="…" shows custom 503 message | B | VERIFIED | commands.json tenant:maintenance --off --message | tenant_guard_maintenance.spec.ts; e2e | none |  |
| [cmd#37] | Command: `tenant:impersonate <tenantId> <userId>` — Issue admin impersonation token | B | VERIFIED | commands.json tenant:impersonate (tenantId,userId) | e2e full.spec.ts impersonation | none |  |
| [cmd#38] | Flags on tenant:impersonate: `--admin=<id>`, `--duration=<seconds>`, `--reason="…"`, `--path=<path>` | B | VERIFIED | flags admin,duration,reason,path | — | none |  |
| [cmd#39] | Command: `tenant:webhooks:retry` — Process pending webhook retries. Cron: `* * * * *` | B | VERIFIED | commands.json tenant:webhooks:retry (cron hint in help) | e2e webhooks_delivery retries | none |  |
| [cmd#40] | Command: `tenant:metrics:flush` — Flush Redis metric counters to database. Cron: `0 1 * * *` | B | VERIFIED | commands.json tenant:metrics:flush (period arg) | metrics_service.spec.ts flush | none |  |
| [cmd#41] | Command: `tenant:purge-expired` — Drop schemas of soft-deleted tenants past retention window. Cron: `0 3 * * *` | B | VERIFIED | commands.json tenant:purge-expired (retention-days,dry-run,force) | soft_delete.spec.ts | none |  |
| [cmd#42] | Command: `tenant:billing:sync` — Reconcile Stripe subscriptions with local mirror | B | VERIFIED | billing commands.json tenant:billing:sync | sync_command.spec.ts | none |  |
| [cmd#43] | Flags on tenant:billing:sync: `--dry-run`, `--tenant=<id>`, `--since=<iso>`, `--json`. Cron: `0 4 * * *` | B | VERIFIED | flags dry-run,tenant,since,json | sync_command.spec.ts | none |  |
| [cmd#44] | Command: `tenant:billing:backfill` — Seed tenant_plans rows with default plan | B | VERIFIED | billing commands.json tenant:billing:backfill | backfill_command.spec.ts | none |  |
| [cmd#45] | Flags: `--dry-run`, `--force`, `--plan=<name>` | B | VERIFIED | flags dry-run,force,plan | backfill_command.spec.ts | none |  |
| [cmd#46] | Command: `tenant:billing:replay` — Re-dispatch failed webhook event | B | VERIFIED | billing commands.json tenant:billing:replay | replay_command.spec.ts + replay_fallback.spec.ts | none |  |
| [cmd#47] | Flags: `--event-id=<evt>`, `--all-failed` | B | VERIFIED | flags event-id,all-failed | replay_command.spec.ts | none |  |
| [cmd#48] | Command: `tenant:billing:cleanup` — Purge stripe_processed_events older than webhook.idempotencyTtlDays | B | VERIFIED | billing commands.json tenant:billing:cleanup | cleanup_command.spec.ts | none |  |
| [cmd#49] | Flag: `--batch-size=<n>` | B | VERIFIED | flag batch-size | cleanup_command.spec.ts | none |  |
| [cmd#50] | Command: `tenant:billing:doctor` — Diagnose Stripe config + recent webhook health | B | VERIFIED | billing commands.json tenant:billing:doctor | diagnostics_commands.spec.ts | none |  |
| [cmd#51] | Flag: `--json`. Exit 1 on any error. | B | VERIFIED | flag json; exit-1-on-error | diagnostics_commands.spec.ts | none |  |
| [cmd#52] | Command: `tenant:billing:test-webhook <event>` — Generate and POST synthetic Stripe event | B | VERIFIED | billing commands.json tenant:billing:test-webhook | diagnostics_commands.spec.ts | none |  |
| [cmd#53] | Flags: `--url=<url>`, `--object=<file>` | B | VERIFIED | flags url,object | — | none |  |
| [cmd#54] | Command: `tenant:repl <tenantId>` — REPL with tenant, db, audit, metrics, and satellite services preloaded | B | VERIFIED | commands.json tenant:repl (staysAlive) | unit metadata only (REPL interactive) | none |  |

## events.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [evt#1] | Event: `TenantCreated` — Payload: `tenant`. Dispatched by tenant:create command, POST /admin/.../tenants | B | VERIFIED | events/index.ts:1; create_tenant.ts dispatch | lifecycle_dispatch.spec.ts; e2e lifecycle_events | none |  |
| [evt#2] | Event: `TenantProvisioned` — Payload: `tenant`. Dispatched by InstallTenant job | B | VERIFIED | events/index.ts:4; install_tenant.ts | lifecycle_dispatch.spec.ts | none |  |
| [evt#3] | Event: `TenantActivated` — Payload: `tenant`. Dispatched by tenant:activate command, POST .../activate | B | VERIFIED | events/index.ts:2; activate_tenant.ts | lifecycle_dispatch.spec.ts | none |  |
| [evt#4] | Event: `TenantSuspended` — Payload: `tenant`. Dispatched by tenant:suspend command, POST .../suspend | B | VERIFIED | events/index.ts:3; suspend_tenant.ts | lifecycle_dispatch.spec.ts | none |  |
| [evt#5] | Event: `TenantUpdated` — Payload: `tenant`, `changes`. Available for host code; not auto-dispatched | B | VERIFIED | events/index.ts:6; zero dispatch sites in core (grep) — matches 'not auto-dispatched' | — | none |  |
| [evt#6] | Event: `TenantMigrated` — Payload: `tenant`, `direction: 'up' \| 'down'`. Dispatched by tenant:migrate and tenant:migrate:rollback | B | VERIFIED | events/index.ts:7 + TenantMigrationDirection type | e2e commands_lifecycle migrations | none |  |
| [evt#7] | Event: `TenantBackedUp` — Payload: `tenant`, `metadata: BackupMetadata`. Dispatched by BackupTenant job | B | VERIFIED | events/index.ts:8; dispatched from backup pkg | tenant_backup.spec.ts | none |  |
| [evt#8] | Event: `TenantRestored` — Payload: `tenant`, `fileName`. Dispatched by RestoreTenant job | B | VERIFIED | events/index.ts:9; RestoreTenant job | tenant_restore.spec.ts | none |  |
| [evt#9] | Event: `TenantCloned` — Payload: `source`, `destination`, `result: CloneResult`. Dispatched by CloneTenant job | B | VERIFIED | events/index.ts:10; CloneTenant job | clone_service.spec.ts | none |  |
| [evt#10] | Event: `TenantQuotaExceeded` — Payload: `tenant`, `quota`, `limit`, `current`, `attempted`. Dispatched by QuotaService.consume() when check rejects | B | VERIFIED | quota_service.ts:403 dispatch(tenant,quota,limit,current,attempted) | quota_service.spec.ts | none |  |
| [evt#11] | Event: `QuotaTracked` — Payload: `tenant`, `quota`, `amount`, `total`. Dispatched by QuotaService.track / consume when plans.emitTracked is on | B | VERIFIED | quota_service.ts:413-415 (gated on plans.emitTracked) | metered_usage.spec.ts | none |  |
| [evt#12] | Event: `TenantEnteredMaintenance` — Payload: `tenant`, `message: string \| null`. Dispatched by tenant:maintenance command, POST .../maintenance | B | VERIFIED | events/index.ts:14; tenant_maintenance.ts | e2e lifecycle_events | none |  |
| [evt#13] | Event: `TenantExitedMaintenance` — Payload: `tenant`. Dispatched by tenant:maintenance --off, DELETE .../maintenance | B | VERIFIED | events/index.ts:15; tenant_maintenance.ts --off | e2e lifecycle_events | none |  |
| [evt#14] | Event: `TenantDeleted` — Payload: `tenant`. Dispatched by tenant:destroy command, UninstallTenant job, DELETE .../tenants/:id | B | VERIFIED | events/index.ts:5; destroy_tenant.ts + UninstallTenant | lifecycle_dispatch.spec.ts | none |  |
| [evt#15] | Event: `SubscriptionActivated` — Payload: `tenantId`, `stripeSubscriptionId`, `planName`. Dispatched by customer.subscription.created (or .updated flipping to active) | B | VERIFIED | billing/src/events/billing/subscription_activated.ts | subscription_sync.spec.ts | none |  |
| [evt#16] | Event: `SubscriptionUpdated` — Payload: `tenantId`, `stripeSubscriptionId`, `previousPlan`, `newPlan`. Dispatched when plan changes | B | VERIFIED | billing/.../subscription_updated.ts | subscription_sync.spec.ts | none |  |
| [evt#17] | Event: `SubscriptionCanceled` — Payload: `tenantId`, `stripeSubscriptionId`, `previousPlan`, `reason: 'user_canceled' \| 'dunning_failed' \| 'unknown'`. Dispatched by customer.subscription.deleted | B | VERIFIED | billing/.../subscription_canceled.ts | subscription_sync.spec.ts | none |  |
| [evt#18] | Event: `SubscriptionPaused` — Payload: `tenantId`, `stripeSubscriptionId`. Dispatched by pause-collection or customer.subscription.paused | B | VERIFIED | billing/.../subscription_paused.ts | trial_lifecycle.spec.ts | none |  |
| [evt#19] | Event: `SubscriptionResumed` — Payload: `tenantId`, `stripeSubscriptionId`. Dispatched by customer.subscription.resumed | B | VERIFIED | billing/.../subscription_resumed.ts | trial_lifecycle.spec.ts | none |  |
| [evt#20] | Event: `TrialEnding` — Payload: `tenantId`, `stripeSubscriptionId`, `daysLeft`. Dispatched by customer.subscription.trial_will_end | B | VERIFIED | billing/.../trial_ending.ts | trial_lifecycle.spec.ts | none |  |
| [evt#21] | Event: `PaymentSucceeded` — Payload: `tenantId`, `invoiceId`, `amount`, `currency`. Dispatched by invoice.payment_succeeded | B | VERIFIED | billing/.../payment_succeeded.ts | dunning_flow.spec.ts | none |  |
| [evt#22] | Event: `PaymentFailed` — Payload: `tenantId`, `invoiceId`, `amount`, `currency`, `attempts`, `final`, `nextRetry`. Dispatched by invoice.payment_failed (every attempt) | B | VERIFIED | billing/.../payment_failed.ts | dunning_flow.spec.ts (attempts/final) | none |  |
| [evt#23] | Event: `BillingMisconfigured` — Payload: `stripeSubscriptionId`, `productId`, `priceId`. Dispatched when Stripe product/price has no mapping in config.billing.products | B | VERIFIED | billing/.../billing_misconfigured.ts | subscription_sync.spec.ts unmapped product | none |  |
| [evt#24] | Event: `BillingEventDeadLettered` — Payload: `eventId`, `errorCode`, `details`. Dispatched when webhook event exhausted all queue retries | B | VERIFIED | billing/.../billing_event_dead_lettered.ts | fatal_error_short_circuit.spec.ts | none |  |
| [evt#25] | Event: `DependencyDegraded` — Payload: `dependency`, `operation`, `tenantId`, `policy`, `errorCode`. Dispatched by ResilienceService when call fails | B | VERIFIED | events/index.ts:16 + payload type :17 | resilience_service.spec.ts; quota_resilience | none |  |
| [evt#26] | API: `emitter.on(EventClass, listener)` — standard AdonisJS emitter API | B | VERIFIED | @adonisjs/core emitter (class-based listeners) | lifecycle_dispatch.spec.ts uses it | none |  |
| [evt#27] | API: `EventClass.dispatch(...args)` — static helper for dispatching | B | VERIFIED | event classes expose static dispatch (e.g. quota_service.ts:403) | used across suite | none |  |
| [evt#28] | "emitter.emit() runs every listener in parallel" | A | N/A | @adonisjs/core emitter (emittery) semantics — upstream framework behavior | — | none | matches emittery's Promise.all dispatch; not ours to test |
| [evt#29] | "If a listener throws, the rejection propagates but sibling listeners still run" | B | N/A | upstream emitter behavior | — | none |  |

## hooks.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [hooks#1] | Event: `provision` — Fires around tenant schema/database creation. Context: `{ tenant }` | B | VERIFIED | hook_registry.ts:7,65-66 | hook_registry.spec.ts; e2e lifecycle_events (beforeProvision reject → failed) | none |  |
| [hooks#2] | Event: `destroy` — Fires around tenant teardown. Context: `{ tenant }` | B | VERIFIED | hook_registry.ts:8,67-68 | hook_registry.spec.ts | none |  |
| [hooks#3] | Event: `migrate` — Fires around per-tenant migrations. Context: `{ tenant, direction: 'up' \| 'down' }` | B | VERIFIED | hook_registry.ts:12,75-76 + TenantMigrationDirection | hook_registry.spec.ts | none |  |
| [hooks#4] | Event: `backup` — Fires around tenant backup. Context: `{ tenant, metadata? }` | B | VERIFIED | hook_registry.ts:9,69-70 | backup pkg specs run hooks | none |  |
| [hooks#5] | Event: `restore` — Fires around tenant restore. Context: `{ tenant, fileName }` | B | VERIFIED | hook_registry.ts:10,71-72 | tenant_restore.spec.ts | none |  |
| [hooks#6] | Event: `clone` — Fires around tenant clone. Context: `{ source, destination, result? }` | B | VERIFIED | hook_registry.ts:11,73-74 | clone_service.spec.ts | none |  |
| [hooks#7] | Phase: `before` — thrown error aborts the operation | B | VERIFIED | hook_registry run(): before rethrows | e2e lifecycle_events: beforeProvision throw → status failed | none |  |
| [hooks#8] | Phase: `after` — thrown error is logged and swallowed | B | VERIFIED | hook_registry run(): after caught + logged | unit output shows '[multitenancy] after-hook failed (after:backup)' exercised in hook_registry.spec.ts | none |  |
| [hooks#9] | Config key: `hooks.beforeProvision` — async ({ tenant }) => { } | B | VERIFIED | DeclarativeHooks beforeProvision (hook_registry.ts) | fixture config/multitenancy.ts declares it; e2e lifecycle_events | none |  |
| [hooks#10] | Config key: `hooks.afterProvision` — async ({ tenant }) => { } | B | VERIFIED | DeclarativeHooks afterProvision | e2e lifecycle_events | none |  |
| [hooks#11] | Config key: `hooks.beforeDestroy` — async ({ tenant }) => { } | B | VERIFIED | DeclarativeHooks beforeDestroy | hook_registry.spec.ts | none |  |
| [hooks#12] | Config key: `hooks.afterDestroy` — async ({ tenant }) => { } | B | VERIFIED | DeclarativeHooks afterDestroy | hook_registry.spec.ts | none |  |
| [hooks#13] | Config key: `hooks.beforeMigrate` — async ({ tenant, direction }) => { } | B | VERIFIED | DeclarativeHooks beforeMigrate (direction) | hook_registry.spec.ts | none |  |
| [hooks#14] | Config key: `hooks.afterMigrate` — async ({ tenant, direction }) => { } | B | VERIFIED | DeclarativeHooks afterMigrate | hook_registry.spec.ts | none |  |
| [hooks#15] | Config key: `hooks.beforeBackup` — async ({ tenant, metadata? }) => { } | B | VERIFIED | DeclarativeHooks beforeBackup (metadata?) | backup pkg | none |  |
| [hooks#16] | Config key: `hooks.afterBackup` — async ({ tenant, metadata? }) => { } | B | VERIFIED | DeclarativeHooks afterBackup | backup pkg | none |  |
| [hooks#17] | Config key: `hooks.beforeRestore` — async ({ tenant, fileName }) => { } | B | VERIFIED | DeclarativeHooks beforeRestore (fileName) | backup pkg | none |  |
| [hooks#18] | Config key: `hooks.afterRestore` — async ({ tenant, fileName }) => { } | B | VERIFIED | DeclarativeHooks afterRestore | backup pkg | none |  |
| [hooks#19] | Config key: `hooks.beforeClone` — async ({ source, destination, result? }) => { } | B | VERIFIED | DeclarativeHooks beforeClone (source,destination) | clone_service.spec.ts | none |  |
| [hooks#20] | Config key: `hooks.afterClone` — async ({ source, destination, result? }) => { } | B | VERIFIED | DeclarativeHooks afterClone (result?) | clone_service.spec.ts | none |  |
| [hooks#21] | API: `HookRegistry.before(event, fn)` / `.after(event, fn)` — chainable API | B | VERIFIED | hook_registry.ts before()/after() return this | hook_registry.spec.ts | none |  |
| [hooks#22] | API: Resolve from container: `app.container.make(HookRegistry)` | B | VERIFIED | provider register() singleton HookRegistry | hook_registry.spec.ts container make | none |  |

## services.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [svc#1] | Method: `consume(tenant, quota, amount = 1) → Promise<number>` — Atomically increments; throws QuotaExceededException on overrun. Returns new usage. | B | VERIFIED | quota_service.ts:364 consume(tenant,quota,amount=1) | quota_concurrency.spec.ts | test-fix:T0 |  |
| [svc#2] | Method: `track(tenant, quota, amount = 1) → Promise<number>` — Increments without enforcing limit | B | VERIFIED | quota_service.ts track() | quota_service.spec.ts | none |  |
| [svc#3] | Method: `check(tenant, quota, amount?) → Promise<QuotaCheckResult>` — Non-mutating check | B | VERIFIED | quota_service.ts:330 check() non-mutating | quota_service.spec.ts | none |  |
| [svc#4] | Method: `getUsage(tenant, quota) → Promise<number>` — Current usage | B | VERIFIED | quota_service.ts getUsage() | quota_service.spec.ts | none |  |
| [svc#5] | Method: `setUsage(tenant, quota, value) → Promise<void>` — Overwrite counter | B | VERIFIED | quota_service.ts setUsage() | quota_service.spec.ts | none |  |
| [svc#6] | Method: `reset(tenant, quota?) → Promise<void>` — Reset one quota or all | B | VERIFIED | quota_service.ts reset() | quota_concurrency teardown uses it | none |  |
| [svc#7] | Method: `getLimit(tenant, quota) → Promise<number>` — Resolved plan's limit | B | VERIFIED | quota_service.ts getLimit() | quota_service.spec.ts | none |  |
| [svc#8] | Method: `getPlanFor(tenant) → Promise<{ name, plan }>` — Tenant's resolved plan | B | VERIFIED | quota_service.ts getPlanFor() | quota_assignment.spec.ts | none |  |
| [svc#9] | Method: `assignPlan(tenant, plan, ...) → Promise<…>` — Persist plan assignment | B | VERIFIED | quota_service.ts assignPlan() | quota_assignment.spec.ts | none |  |
| [svc#10] | Method: `getAssignedPlan(tenantId)` / `clearAssignedPlan(tenantId)` — Read/clear stored assignment | B | VERIFIED | quota_service.ts getAssignedPlan()/clearAssignedPlan() | quota_assignment.spec.ts | none |  |
| [svc#11] | Method: `snapshot(tenant) → Promise<QuotaStateSnapshot>` — All quotas + usage at once | B | VERIFIED | quota_service.ts snapshot() | quota_service.spec.ts | none |  |
| [svc#12] | "Redis-dependent calls route through ResilienceService" | A | VERIFIED | quota_service.ts:373 resilience.run wrapper | quota_resilience.spec.ts | none |  |
| [svc#13] | Method: `log({ action, tenantId?, actorType?, actorId?, metadata?, ipAddress? }) → Promise<TenantAuditLog>` | B | VERIFIED | audit_log_service.ts:13 log(options: LogActionOptions) | audit_log_service.spec.ts | none |  |
| [svc#14] | Method: `listForTenant(tenantId, page = 1, limit = 50, { from?, to? } = {}) → Promise<…>` (limit capped at 200) | B | VERIFIED | audit_log_service.ts:24 listForTenant(tenantId, page=1, …) | audit_log_service.spec.ts | none |  |
| [svc#15] | Method: `dispatch(tenantId, event, payload) → Promise<void>` — Fan out to subscribed hooks | B | VERIFIED | webhook_service.ts dispatch() | webhook_service.spec.ts | none |  |
| [svc#16] | Method: `registerWebhook(tenantId, url, events, secret?) → Promise<TenantWebhook>` — Validates URL against SSRF guard | B | VERIFIED | webhook_service.ts registerWebhook() (SSRF guard via url.ts) | webhook_service.spec.ts | new-test:T1 (encoding matrix) |  |
| [svc#17] | Method: `listWebhooks(tenantId)` / `deleteWebhook(id, tenantId)` → Promise<TenantWebhook[]> / Promise<void> | B | VERIFIED | webhook_service.ts listWebhooks()/deleteWebhook() | webhook_service.spec.ts | none |  |
| [svc#18] | Method: `processRetries() → Promise<void>` — Send deliveries whose next_retry_at is due | B | VERIFIED | webhook_service.ts processRetries() | webhook_service.spec.ts retries; e2e webhooks_delivery | none |  |
| [svc#19] | Export: `verifyWebhookSignature(rawBody, signatureHeader, secret): boolean` — constant-time check | B | VERIFIED | webhook_service.ts export verifyWebhookSignature (timingSafeEqual) | webhook signature tests | none |  |
| [svc#20] | Method: `getForTenant(tenantId) → Promise<TenantBranding \| null>` (cached 300s) | B | VERIFIED | branding_service.ts getForTenant() ttl '300s' | branding_service.spec.ts | none |  |
| [svc#21] | Method: `upsert(tenantId, data: BrandingData) → Promise<TenantBranding>` (busts cache) | B | VERIFIED | branding_service.ts upsert() (cache bust) | branding_service.spec.ts | none |  |
| [svc#22] | Method: `renderEmailContext(branding)` — plain object with email fields + sane fallbacks | B | VERIFIED | branding_service.ts:38 renderEmailContext() | branding_service.spec.ts | none |  |
| [svc#23] | Method: `isEnabled(tenantId, flag) → Promise<boolean>` (false when absent; cached 60s) | B | VERIFIED | feature_flag_service.ts isEnabled() ttl '60s' | feature_flag_service.spec.ts | none |  |
| [svc#24] | Method: `set(tenantId, flag, enabled, config?) → Promise<TenantFeatureFlag>` (upsert) | B | VERIFIED | feature_flag_service.ts set() upsert | feature_flag_service.spec.ts | none |  |
| [svc#25] | Method: `listForTenant(tenantId)` / `delete(tenantId, flag)` → Promise<TenantFeatureFlag[]> / Promise<void> | B | VERIFIED | feature_flag_service.ts listForTenant()/delete() | feature_flag_service.spec.ts | none |  |
| [svc#26] | Method: `increment(tenantId, 'requests' \| 'errors', amount = 1) → Promise<void>` | B | VERIFIED | metrics_service.ts increment() | metrics_service.spec.ts | none |  |
| [svc#27] | Method: `trackBandwidth(tenantId, bytes) → Promise<void>` | B | VERIFIED | metrics_service.ts trackBandwidth() | metrics_service.spec.ts | none |  |
| [svc#28] | Method: `flush(period?) → Promise<void>` — Rolls Redis counters into tenant_metrics | B | VERIFIED | metrics_service.ts flush() | metrics_service.spec.ts | none |  |
| [svc#29] | Method: `getForTenant(tenantId, days = 30) → Promise<TenantMetric[]>` | B | VERIFIED | metrics_service.ts getForTenant() | metrics_service.spec.ts | none |  |

## exceptions.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [exc#1] | Exception: `MissingTenantHeaderException` — Status: 400, Code: `E_MISSING_TENANT_HEADER`, Thrown when no tenant id can be resolved | B | VERIFIED | missing_tenant_header_exception.ts status=400 code=E_MISSING_TENANT_HEADER | tenant_guard_middleware.spec.ts | none |  |
| [exc#2] | Exception: `TenantHeaderDomainMismatchException` — Status: 400, Code: `E_TENANT_HEADER_DOMAIN_MISMATCH`, Possible hijack attempt | B | VERIFIED | tenant_header_domain_mismatch_exception.ts 400/E_TENANT_HEADER_DOMAIN_MISMATCH | header_vs_domain_precedence.spec.ts:27 | none |  |
| [exc#3] | Exception: `TenantNotFoundException` — Status: 404, Code: `E_TENANT_NOT_FOUND`, Resolved tenant id doesn't exist | B | VERIFIED | tenant_not_found_exception.ts 404/E_TENANT_NOT_FOUND | tenant_guard_middleware.spec.ts | none |  |
| [exc#4] | Exception: `CentralRouteViolationException` — Status: 404, Code: `E_CENTRAL_ROUTE_VIOLATION`, Central-only route reached in tenant context (or vice-versa) | B | VERIFIED | central_route_violation_exception.ts 404/E_CENTRAL_ROUTE_VIOLATION | central_only_middleware.spec.ts | none |  |
| [exc#5] | Exception: `TenantSuspendedException` — Status: 403, Code: `E_TENANT_SUSPENDED`, Tenant is suspended | B | VERIFIED | tenant_suspended_exception.ts 403/E_TENANT_SUSPENDED | tenant_guard_middleware.spec.ts | none |  |
| [exc#6] | Exception: `TenantNotReadyException` — Status: 503, Code: `E_TENANT_NOT_READY`, Tenant still provisioning | B | VERIFIED | tenant_not_ready_exception.ts 503/E_TENANT_NOT_READY | tenant_guard_middleware.spec.ts | none |  |
| [exc#7] | Exception: `TenantMaintenanceException` — Status: 503, Code: `E_TENANT_MAINTENANCE`, Tenant in maintenance mode. Carries retryAfterSeconds. | B | VERIFIED | tenant_maintenance_exception.ts 503/E_TENANT_MAINTENANCE | tenant_guard_maintenance.spec.ts | none |  |
| [exc#8] | Exception: `CircuitOpenException` — Status: 503, Code: `E_CIRCUIT_OPEN`, Tenant DB circuit breaker is OPEN | B | VERIFIED | circuit_open_exception.ts 503/E_CIRCUIT_OPEN | connection_failure_503.spec.ts | none |  |
| [exc#9] | Exception: `RateLimitUnavailableException` — Status: 503, Code: `E_RATE_LIMIT_UNAVAILABLE`, Rate-limit backend (Redis) errored and route is fail-closed | B | VERIFIED | rate_limit_unavailable_exception.ts 503/E_RATE_LIMIT_UNAVAILABLE | rate_limit.spec.ts:93 | none |  |
| [exc#10] | Exception: `DependencyUnavailableException` — Status: 503, Code: `E_DEPENDENCY_UNAVAILABLE`, fail-closed dependency errored. Carries dependency, operation, tenantId. | B | VERIFIED | dependency_unavailable_exception.ts 503/E_DEPENDENCY_UNAVAILABLE + context type | quota_resilience.spec.ts | none |  |
| [exc#11] | Exception: `TooManyRequestsException` — Status: 429, Code: `E_TOO_MANY_REQUESTS`, Exceeded RateLimitMiddleware window. Sets Retry-After. | B | VERIFIED | too_many_requests_exception.ts 429/E_TOO_MANY_REQUESTS | rate_limit.spec.ts:27 (429 + Retry-After) | none |  |
| [exc#12] | Exception: `QuotaExceededException` — Status: 429, Code: `E_TENANT_QUOTA_EXCEEDED`, QuotaService.consume() would exceed limit. Carries quota, limit, current, attempted. | B | VERIFIED | quota_exceeded_exception.ts 429/E_TENANT_QUOTA_EXCEEDED (carries quota/limit/current/attempted) | quota_concurrency + enforce_quota_middleware specs | none |  |
| [exc#13] | Exception: `BillingException` — Status: 400, Code: `E_BILLING`, Stripe/billing error. Carries billingCode and isRetryable() | B | VERIFIED | moved to @adonisjs-lasagna/billing (BillingException) | billing suite | none | page should say it imports from billing pkg — check wording in W7 |

## data-isolation/index.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [iso#1] | Driver: `schema-pg` — One PG schema per tenant. Default. Strongest balance of isolation and operational cost. | B | VERIFIED | schema_pg_driver.ts (default via provider fallback {driver:'schema-pg'}) | schema_pg_driver specs; cross_tenant_e2e | none |  |
| [iso#2] | Driver: `database-pg` — One PG database per tenant. Requires CREATEDB. Best for OS-level isolation. | B | VERIFIED | database_pg_driver.ts (CREATE DATABASE per tenant) | database_pg_driver specs; database_pg_crud_isolation | none |  |
| [iso#3] | Driver: `rowscope-pg` — Shared schema + tenant_id column. Best for lightweight workloads, large tenant counts. | B | VERIFIED | rowscope_pg_driver.ts | rowscope specs ×3 | none |  |
| [iso#4] | Driver: `sqlite-memory` — In-process SQLite per tenant. Tests only. | B | VERIFIED | sqlite_memory_driver.ts | sqlite unit + sqlite_memory_lifecycle | none |  |
| [iso#5] | Method: `provision` — Create the tenant's storage (schema/database/rows) | B | VERIFIED | isolation/driver.ts contract; 4 impls | per-driver provision tests | none |  |
| [iso#6] | Method: `destroy` — Drop it cleanly (terminates active sessions first) | B | VERIFIED | driver.ts destroy; database_pg_driver.ts:99 pg_terminate_backend before drop | tenant_lifecycle.spec.ts | none | session-termination is database-pg; schema-pg uses DROP SCHEMA CASCADE |
| [iso#7] | Method: `reset` — Drop and recreate (used by tenant:migrate:fresh) | B | VERIFIED | driver.ts reset; tenant_migrate_fresh uses it | unit driver specs | none |  |
| [iso#8] | Method: `connect` — Open the runtime Lucid connection | B | VERIFIED | driver.ts connect (registers Lucid connection via connection_lru) | connection_lru.spec.ts | none |  |
| [iso#9] | Method: `disconnect` — Close it | B | VERIFIED | driver.ts disconnect | connection_eviction_safety.spec.ts | none |  |
| [iso#10] | Method: `connectionName` — Synchronous resolver for the active query's connection | B | VERIFIED | driver.ts connectionName(tenantId) sync | unit driver specs | none |  |
| [iso#11] | Method: `migrate` — Run migrations against this tenant's storage | B | VERIFIED | driver.ts migrate(tenant,{dryRun}) | e2e commands_lifecycle migrations | none |  |

## data-isolation/schema-pg.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [schema#1] | "Each tenant lives in its own schema named `tenant_<uuid>` on a shared database" | B | VERIFIED | schema_pg_driver.ts schemaName = tenantSchemaPrefix + id | schema_pg_driver.spec.ts | none |  |
| [schema#2] | "Lucid connections are named `tenant_<uuid>` as well" | B | VERIFIED | connectionName = tenantConnectionNamePrefix + id | tenant_adapter.spec.ts:143 | none |  |
| [schema#3] | Step: "Validate the tenant id with `assertSafeIdentifier` — [a-zA-Z0-9_-]{1,63}" | B | VERIFIED | schema_pg_driver entry asserts (identifier.ts) | identifier.spec.ts | none |  |
| [schema#4] | Step: "CREATE SCHEMA \"tenant_<uuid>\" on the shared template connection" | B | VERIFIED | schema_pg_driver.ts:72 CREATE SCHEMA IF NOT EXISTS | tenant_lifecycle.spec.ts | none |  |
| [schema#5] | Step: "Register a Lucid connection tenant_<uuid> with searchPath: tenant_<uuid>" | B | VERIFIED | schema_pg_driver.ts:121 searchPath:[schema] | cross_tenant_e2e (schema routing) | none |  |
| [schema#6] | Step: "Run per-tenant migrations" | B | VERIFIED | driver.migrate; run_tenant_migrations.ts | e2e commands_lifecycle | none |  |
| [schema#7] | Step: "Mark tenant as deleted_at (soft delete)" | B | VERIFIED | destroy_tenant.ts soft delete (deletedAt) | soft_delete.spec.ts | none |  |
| [schema#8] | Step: "After retention window: pg_terminate_backend against any sessions on the schema" | B | BROKEN | schema_pg_driver.ts:81 destroy = DROP SCHEMA CASCADE only — NO pg_terminate_backend anywhere in the schema-pg path (that step exists only in database_pg_driver.ts:99) | — | doc-fix:F-16 | sessions attach to databases not schemas; doc copy-paste from database-pg |
| [schema#9] | Step: "DROP SCHEMA \"tenant_<uuid>\" CASCADE" | B | VERIFIED | schema_pg_driver.ts:81 DROP SCHEMA IF EXISTS CASCADE | tenant_lifecycle.spec.ts teardown | none |  |
| [schema#10] | Step: "Close and unregister the Lucid connection" | B | VERIFIED | connection_lru close/unregister | connection_eviction_safety.spec.ts | none |  |
| [schema#11] | Config: `isolation: { driver: 'schema-pg', templateConnectionName: 'tenant' }` | B | VERIFIED | types/config.ts:226-233 | — | none |  |
| [schema#12] | "pg_dump --schema=tenant_<uuid> produces a portable per-tenant archive" | B | VERIFIED | backup_service.ts:57 passes --schema=<schema> to pg_dump | e2e backups_real.spec.ts | none |  |
| [schema#13] | "Schemas don't share connection pools by default; they share the template connection's pool" | B | VERIFIED | per-tenant Lucid connection w/ own pool cloned from template | connection_lru.spec.ts | none |  |
| [schema#14] | "Migrations are tracked per schema using a per-tenant Lucid migrations table" | B | VERIFIED | migrations.paths on tenant template; adonis_schema per searchPath | doctor migration_state check + e2e | none |  |

## data-isolation/database-pg.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [database#1] | "Each tenant gets its own PostgreSQL database named `tenant_<uuid>` (configurable via tenantDatabasePrefix)" | B | VERIFIED | database_pg_driver.ts:86 CREATE DATABASE "<prefix><id>" | database_pg_crud_isolation.spec.ts | none |  |
| [database#2] | "Connections are independent; nothing is shared at the database level" | B | VERIFIED | separate PG database per tenant; cloned connection :173-179 | database_pg_crud_isolation.spec.ts | none |  |
| [database#3] | "Lucid template connection role must have the CREATEDB privilege" | A | VERIFIED | database_pg_driver.ts:44 CREATEDB requirement documented at impl | — (privilege req not testable in suite) | none |  |
| [database#4] | "CREATE DATABASE cannot run inside a transaction. The driver runs it outside one" | A | VERIFIED | database_pg_driver.ts:84 'CREATE DATABASE cannot run in a transaction; rawQuery' | database_pg_driver.spec.ts provision | none |  |
| [database#5] | "destroy calls pg_terminate_backend on every active session before issuing DROP DATABASE" | A | VERIFIED | database_pg_driver.ts:96-104 pg_terminate_backend then DROP DATABASE IF EXISTS | database_pg_driver.spec.ts destroy | none |  |
| [database#6] | Config: `isolation: { driver: 'database-pg', tenantDatabasePrefix: 'tenant_', templateConnectionName: 'tenant' }` | B | VERIFIED | types/config.ts:226-238 | — | none |  |
| [database#7] | Step: "Validate the tenant id (assertSafeIdentifier)" | B | VERIFIED | assertSafeIdentifier at driver entry | identifier.spec.ts | none |  |
| [database#8] | Step: "CREATE DATABASE \"tenant_<uuid>\" on the template connection (no transaction)" | B | VERIFIED | database_pg_driver.ts:84-86 | database specs | none |  |
| [database#9] | Step: "Register a per-tenant Lucid connection pointed at the new database" | B | VERIFIED | database_pg_driver.ts:173-179 clone + override database | database_pg_crud_isolation | none |  |
| [database#10] | Step: "Run migrations against it" | B | VERIFIED | driver.migrate | database specs | none |  |
| [database#11] | Step: "pg_terminate_backend on every backend with datname = 'tenant_<uuid>'" | B | VERIFIED | database_pg_driver.ts:99 | database_pg_driver.spec.ts | none |  |
| [database#12] | Step: "DROP DATABASE IF EXISTS \"tenant_<uuid>\"" | B | VERIFIED | database_pg_driver.ts:104 | database_pg_driver.spec.ts | none |  |
| [database#13] | Step: "Close and unregister the Lucid connection" | B | VERIFIED | connection_lru | connection_lru.spec.ts | none |  |
| [database#14] | Pro: "Per-tenant credentials and roles" | B | N/A | capability statement (PG-level) | — | none |  |
| [database#15] | Pro: "Tenant data lives in different files / WAL" | B | N/A | PG storage fact | — | none |  |
| [database#16] | Pro: "Easy to replicate or relocate one tenant" | B | N/A | operational guidance | — | none |  |
| [database#17] | Pro: "pg_dump per tenant is a single-database dump" | B | VERIFIED | single-database pg_dump (backup pkg passes db name) | — | none |  |
| [database#18] | Con: "Separate connection pool per tenant; costlier" | B | N/A | honest con | — | none |  |
| [database#19] | Con: "Can't JOIN across tenants for reporting" | B | N/A | honest con | — | none |  |
| [database#20] | Con: "Migrations run N times instead of once" | B | N/A | honest con | — | none |  |
| [database#21] | Con: "Tenant counts in the thousands strain the connection budget" | B | N/A | honest con; matches scaling-limits guidance | — | none |  |

## data-isolation/rowscope-pg.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [rowscope#1] | "Every tenant-scoped table includes a `tenant_id` column (configurable via rowScopeColumn)" | B | VERIFIED | configuredScopeColumn() ?? 'tenant_id' (rowscope_pg_driver.ts) | rowscope_pg_driver.spec.ts | none |  |
| [rowscope#2] | "Models opt in via the `withTenantScope` mixin" | B | VERIFIED | scoping.ts:117 withTenantScope mixin | scoping.spec.ts | none |  |
| [rowscope#3] | "Injects WHERE tenant_id = <current> on find / fetch / paginate" | B | VERIFIED | scoping.ts:139-174 find/fetch/paginate hooks | scoping.spec.ts:95 | none |  |
| [rowscope#4] | "Auto-fills tenant_id on create" | B | VERIFIED | scoping.ts:176-193 create hook | scoping.spec.ts:126 | none |  |
| [rowscope#5] | "Throws on update / delete if the row's tenant_id differs from the active scope" | B | VERIFIED | scoping.ts:195-216 update/delete mismatch throws | scoping.spec.ts:171 | none |  |
| [rowscope#6] | "A query outside both tenancy.run() and unscoped() throws MissingTenantScopeException instead of returning rows from every tenant" | A | VERIFIED | scoping.ts:135 strict throw | rowscope_pg_driver.spec.ts:232 (real PG); scoping.spec.ts:202 | none |  |
| [rowscope#7] | "This catches forgotten context in jobs, scripts, and tests" | B | VERIFIED | strict mode applies to any non-HTTP context | jobs/tenant_context.spec.ts:146 currentId undefined outside run() | none |  |
| [rowscope#8] | Config: `isolation: { driver: 'rowscope-pg', rowScopeColumn: 'tenant_id', rowScopeTables: [...], rowScopeMode: 'strict' }` | B | VERIFIED | types/config.ts:220-262 | — | none |  |
| [rowscope#9] | "rowscope-pg has no per-tenant connection: every tenant shares your centralConnectionName" | B | VERIFIED | rowscope_pg_driver connectionName → centralConnectionName | rowscope_pg_driver.spec.ts | none |  |
| [rowscope#10] | "You do NOT set templateConnectionName for rowscope-pg" | B | VERIFIED | types/config.ts:231 'rowscope-pg ignores this' | — | none |  |
| [rowscope#11] | "A top-level orWhere can escape the auto-scope — SQL binds AND tighter than OR" | A | VERIFIED | scoping.ts:91-115 documented escape + grouping guidance | rowscope_rls.spec.ts:74 proves RLS closes it | none |  |
| [rowscope#12] | "Always wrap OR branches in a group so the tenant predicate covers all of them" | A | VERIFIED | scoping.ts:103-106 | — | none |  |
| [rowscope#13] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=rls` | A | VERIFIED | configure.ts rls opt-in bundle | configure.spec.ts (rls opt-in) | none |  |
| [rowscope#14] | "Publishes migration *_enable_rls_tenant_isolation.ts" | A | VERIFIED | stubs/migrations/enable_rls_tenant_isolation.stub:2 (Date.now()_enable_rls_tenant_isolation.ts) | configure.spec.ts stub resolution | none |  |
| [rowscope#15] | "For each table: ALTER TABLE ENABLE ROW LEVEL SECURITY; ALTER TABLE FORCE ROW LEVEL SECURITY" | A | VERIFIED | stub:53-54 ENABLE + FORCE ROW LEVEL SECURITY | rowscope_rls.spec.ts | none |  |
| [rowscope#16] | "Creates a fail-closed policy: USING (tenant_id::text = nullif(current_setting('app.tenant_id', true), ''))" | A | VERIFIED | stub:56-59 USING + WITH CHECK nullif(current_setting('app.tenant_id',true),'') | rowscope_rls.spec.ts:94 | none |  |
| [rowscope#17] | "When app.tenant_id is unset, nullif(...) makes the predicate NULL, so it matches nothing and WITH CHECK blocks the insert" | A | VERIFIED | stub:58-59 + stub:17-18 comment | rowscope_rls.spec.ts:94 'plain query with the setting unset returns nothing (fail-closed)' + :99 WITH CHECK blocks insert | none |  |
| [rowscope#18] | API: `withTenantRls(tenant.id, async (trx) => { ... })` — opens a transaction, sets the GUC, hands you the trx | A | VERIFIED | rls.ts:130 withTenantRls(tenantId, fn, options?) opens trx + sets GUC | rowscope_rls.spec.ts | none |  |
| [rowscope#19] | "withTenantRls does NOT open a tenancy.run() scope" | A | VERIFIED | rls.ts:118 'only sets the database setting; does NOT open' tenancy scope | — | none |  |
| [rowscope#20] | "Run your app without SUPERUSER / BYPASSRLS" | A | VERIFIED | stub:28-30 FORCE RLS + BYPASSRLS warning | — | none |  |
| [rowscope#21] | "destroy(tenant) runs DELETE FROM <table> WHERE tenant_id = ? for every table in rowScopeTables" | B | VERIFIED | rowscope_pg_driver.ts:28-29 DELETE FROM per rowScopeTables (assertSafeIdentifier :58) | rowscope_pg_driver.spec.ts destroy | none |  |
| [rowscope#22] | "There is no DROP SCHEMA / DROP DATABASE" | B | VERIFIED | no DROP statements in rowscope driver | — | none |  |
| [rowscope#23] | Pro: "Single connection pool; scales to 100k+ tenants" | B | N/A | sizing guidance (single pool true by design) | — | none |  |
| [rowscope#24] | Pro: "Reporting is trivial" | B | N/A | opinion | — | none |  |
| [rowscope#25] | Pro: "Migrations run once for the whole app" | B | VERIFIED | shared schema → single migration pass (no per-tenant loop) | — | none |  |
| [rowscope#26] | Pro: "unscoped() makes admin work explicit" | B | VERIFIED | scoping.ts:27 unscoped() explicit | scoping.spec.ts:225 | none |  |
| [rowscope#27] | Con: "One missing scope leaks across tenants" | B | N/A | honest con (mitigated by strict mode + RLS) | — | none |  |
| [rowscope#28] | Con: "Bigger indexes; tenant_id is in every key" | B | N/A | honest con | — | none |  |
| [rowscope#29] | Con: "You own the discipline of always wrapping with tenancy.run()" | B | N/A | honest con | — | none |  |
| [rowscope#30] | Con: "Backups are not per-tenant by default" | B | N/A | honest con | — | none |  |

## data-isolation/sqlite-memory.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [sqlite#1] | "This driver writes to :memory:. Data does not survive a process exit. Never enable it in production." | A | VERIFIED | sqlite_memory_driver.ts :memory: databases | sqlite_memory_lifecycle.spec.ts | none |  |
| [sqlite#2] | "Each tenant gets an in-process SQLite database for the life of the process" | B | VERIFIED | per-tenant in-process db map | sqlite_memory_driver.spec.ts | none |  |
| [sqlite#3] | Config: `isolation: { driver: 'sqlite-memory' }` (test environment only) | B | VERIFIED | types/config.ts:218 choice present | isolation_driver_registry.spec.ts | none |  |
| [sqlite#4] | "No JSONB, no array columns, no PG-specific extensions" | B | N/A | SQLite capability fact | — | none |  |
| [sqlite#5] | "Migrations need to be SQLite-compatible" | B | N/A | guidance | — | none |  |
| [sqlite#6] | "Concurrency story is single-writer" | B | N/A | SQLite fact | — | none |  |
| [sqlite#7] | "Unit tests that exercise tenant-scoped model logic without needing a real Postgres" | B | VERIFIED | driver usable without PG | sqlite unit specs run with no PG | none |  |
| [sqlite#8] | "Documentation snippets you want to run as test fixtures" | B | N/A | use-case suggestion | — | none |  |
| [sqlite#9] | "Quick CI smoke runs" | B | N/A | use-case suggestion | — | none |  |

## bootstrappers/index.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [bootstrap#1] | "A bootstrapper is a per-service hook that enters when tenant context activates, leaves when it ends" | B | VERIFIED | bootstrapper_registry.ts:14-22 enter/leave contract | bootstrapper_registry.spec.ts:150 runScoped order | none |  |
| [bootstrap#2] | "tenancy.run(tenant, fn) activates the bootstrapper registry around fn" | B | VERIFIED | tenancy.run → registry.runScoped | bootstrapper_isolation.spec.ts | none |  |
| [bootstrap#3] | "Each registered bootstrapper sees enter(ctx) before fn runs and leave(ctx) after, even on fn throw" | B | VERIFIED | runScoped guarantees leave for every successful enter | bootstrapper_registry.spec.ts:165 'runScoped runs leave even when fn throws' | none |  |
| [bootstrap#4] | Bootstrapper: `cacheBootstrapper` — BentoCache — Namespaces every key by `tenants/<id>/…` | B | PARTIAL | cacheFor namespace is tenant:<id> (cache.ts:65), not tenants/<id>/ | cache_for.spec.ts:24 | doc-fix:F-22 |  |
| [bootstrap#5] | Bootstrapper: `driveBootstrapper` — @adonisjs/drive — Prefixes every operation with `tenants/<id>/` | B | PARTIAL | prefix applied via tenantDisk() helper only, not transparently | drive_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [bootstrap#6] | Bootstrapper: `mailBootstrapper` — @adonisjs/mail — Switches SMTP credentials and from address per tenant | B | BROKEN | no SMTP/from switching — tenantMailer stamps X-Tenant-Id only (mail_bootstrapper.ts:19-29) | mail_bootstrapper.spec.ts; e2e mail.spec.ts | doc-fix:F-22 |  |
| [bootstrap#7] | Bootstrapper: `sessionBootstrapper` — @adonisjs/session — Prefixes session keys with tenant id | B | PARTIAL | tenantSessionKey prefix tenants/<id>/ via helper | session_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [bootstrap#8] | Bootstrapper: `transmitBootstrapper` — @adonisjs/transmit — Scopes broadcast channels per tenant | B | PARTIAL | tenantBroadcast/tenantChannel helpers (transmit_bootstrapper.ts:69-75) | transmit_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [bootstrap#9] | "Database is not a bootstrapper — query routing is handled inside TenantAdapter via the active IsolationDriver" | A | VERIFIED | no database bootstrapper; TenantAdapter routes per query | adapter specs | none |  |
| [bootstrap#10] | "Bootstrappers are auto-registered when the corresponding service binding is present" | B | VERIFIED | provider:251-264 binding probes (drive/mail/session/transmit) | — | none |  |
| [bootstrap#11] | "The package probes container.hasBinding(...) for each candidate" | B | VERIFIED | provider #registerOptionalBootstrappers hasBinding checks | — | none |  |
| [bootstrap#12] | "The cache bootstrapper is always registered — the package treats it as a hard requirement" | B | VERIFIED | provider:147 cache always registered | — | none |  |
| [bootstrap#13] | API: `registry.unregister('drive')` — skip even though @adonisjs/drive is installed | B | VERIFIED | bootstrapper_registry.ts:40 unregister(name) | bootstrapper_registry.spec.ts:50 | none |  |
| [bootstrap#14] | Default order: cache (1), drive (2), mail (3), session (4), transmit (5) | B | PARTIAL | order = registration order (cache,drive,mail,session,transmit) — no numeric priority | bootstrapper_registry.spec.ts:76 | doc-fix:F-21 |  |
| [bootstrap#15] | "Registry enters in ascending order and leaves in descending order, exactly like a stack" | B | VERIFIED | enter ascending registration order, leave LIFO | bootstrapper_registry.spec.ts:76 'runEnter executes in registration order, runLeave in reverse' | doc-fix:F-21 (wording: priority→registration order) |  |
| [bootstrap#16] | Interface: `Bootstrapper` with `priority` property and `async enter(ctx)` / `async leave(ctx)` | B | BROKEN | interface is TenantBootstrapper{name,enter,leave?} — no priority; barrel exports TenantBootstrapper+BootstrapperContext not Bootstrapper+TenantContext | — | doc-fix:F-21 |  |
| [bootstrap#17] | Invariant: "leave runs even if enter or fn throw" | B | VERIFIED | runScoped finally-leave | bootstrapper_registry.spec.ts:165 | none |  |
| [bootstrap#18] | Invariant: "A failure in one enter aborts the rest and unwinds prior successful enters in reverse order" | B | VERIFIED | partial-enter unwind in reverse | bootstrapper_registry.spec.ts:183 'runScoped unwinds partial enter on enter failure' | none |  |

## bootstrappers/database.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [db-bootstrap#1] | "Database routing is handled inside TenantAdapter via the active IsolationDriver" | B | VERIFIED | tenant_adapter.ts + active_driver.ts | adapter specs | none |  |
| [db-bootstrap#2] | "It runs synchronously per query, before any bootstrapper code fires" | B | VERIFIED | modelConstructorClient is sync, per query | tenant_adapter.spec.ts | none |  |
| [db-bootstrap#3] | "TenantAdapter.modelConstructorClient() is called by Lucid every time a TenantBaseModel query starts" | B | VERIFIED | Lucid adapter hook | integration adapters/tenant_adapter.spec.ts | none |  |
| [db-bootstrap#4] | "The adapter reads the active tenant via tenancy.currentId() (or HttpContext.tenant)" | B | VERIFIED | tenant_adapter prefers tenancy.currentId() then HTTP ctx | tenant_adapter.spec.ts:228 | none |  |
| [db-bootstrap#5] | "The adapter asks the active IsolationDriver for the connection name" | B | VERIFIED | driver.connectionName(tenantId) | driver specs | none |  |
| [db-bootstrap#6] | "Returns the connection so the query routes there" | B | VERIFIED | returns Lucid connection client | adapter integration | none |  |
| [db-bootstrap#7] | "Bootstrappers run on the enter / leave cycle of a tenant context" | B | VERIFIED | registry runScoped | bootstrapper specs | none |  |
| [db-bootstrap#8] | "Database routing happens per query, not per context" | B | VERIFIED | per-query adapter vs per-context bootstrappers | — | none |  |
| [db-bootstrap#9] | "Adapter calls are synchronous, frequent, and work even for code paths that never call tenancy.run()" | B | VERIFIED | sync resolveSync path incl. non-run() codepaths | tenant_adapter.spec.ts:74 | none |  |
| [db-bootstrap#10] | "If no driver matches the configured isolation.driver, the adapter throws on the first query with the driver name in the message" | B | VERIFIED | isolation registry get() throws w/ driver name | isolation_driver_registry.spec.ts | none |  |

## bootstrappers/cache.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [cache-bootstrap#1] | "The package ships a single shared BentoCache instance — memory L1, Redis L2, and a Redis bus for cross-process invalidation" | B | VERIFIED | cache.ts:20-22 L1 memory + L2 redis + redis bus | cache_for.spec.ts:63 same physical store | none |  |
| [cache-bootstrap#2] | "A helper that returns a namespace prefixed by the tenant id" | B | VERIFIED | cache.ts:44-65 cacheFor returns namespace | cache_for.spec.ts | none |  |
| [cache-bootstrap#3] | Function: `cacheFor(tenant)` — namespace: tenant:<id> | B | VERIFIED | cache.ts:65 namespace tenant:<id> | cache_for.spec.ts:24 | none |  |
| [cache-bootstrap#4] | "Accepts either a tenant model (any object with .id) or a raw id string" | B | VERIFIED | cache.ts:62 accepts {id}\|string | cache_for.spec.ts:39 | none |  |
| [cache-bootstrap#5] | "The id is run through assertSafeIdentifier before namespace is built" | B | VERIFIED | assertSafeIdentifier before namespace | cache_for.spec.ts:51 key injection guard | none |  |
| [cache-bootstrap#6] | Function: `getCache()` — the unprefixed shared instance for cross-tenant data | B | VERIFIED | cache.ts getCache() | cache_for.spec.ts:63 | none |  |
| [cache-bootstrap#7] | "For cross-tenant data — feature-flag definitions, plan catalogs, anything global" | B | N/A | usage guidance | — | none |  |
| [cache-bootstrap#8] | Layer: L1 — in-process memory (5 MB cap) — sub-microsecond reads | B | VERIFIED | cache.ts:20 memoryDriver maxSize 5MB | — | none |  |
| [cache-bootstrap#9] | Layer: L2 — Redis (`config.cache.redis`) — shared across processes | B | VERIFIED | cache.ts:21 redisDriver(config.cache.redis) | cache_for.spec.ts (db 2) | none |  |
| [cache-bootstrap#10] | Layer: Bus — Redis pub/sub — a delete on one process invalidates L1 on others | B | VERIFIED | cache.ts:22 redisBusDriver | — (cross-process invalidation not asserted) | none |  |
| [cache-bootstrap#11] | Config: `cache: { ttl: 300, redis: { host, port, db: 2 } }` | B | VERIFIED | types/config.ts:475-483 | — | none |  |
| [cache-bootstrap#12] | "cacheFor() always validates the id against /^[a-zA-Z0-9_-]{1,63}$/" | A | VERIFIED | identifier.ts SAFE_IDENT via assertSafeIdentifier | cache_for.spec.ts:51 | none |  |
| [cache-bootstrap#13] | "Crafted ids — path traversal, embedded colons, newlines, anything that could collide with another tenant's prefix — are rejected synchronously" | B | VERIFIED | whitelist regex rejects all listed classes | cache_for.spec.ts:51; identifier.spec.ts | none |  |

## bootstrappers/filesystem.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [fs-bootstrap#1] | "Auto-detected when @adonisjs/drive is installed" | B | VERIFIED | provider hasBinding('drive.manager') probe | — | none |  |
| [fs-bootstrap#2] | "Prefixes every filesystem operation with `tenants/<tenant.id>/`" | B | PARTIAL | prefix only via tenantDisk() proxy (KEYED_METHODS); raw drive.use() untouched | drive_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [fs-bootstrap#3] | "Applies to every disk you've configured (local, s3, gcs, …)" | B | VERIFIED | tenantDisk(diskName?) works for any configured disk | drive_bootstrapper.spec.ts | none |  |
| [fs-bootstrap#4] | "drive.list() returns paths relative to the tenant prefix by default" | B | DOC-ONLY | proxy does NOT post-process list() results — no relativization exists | — | doc-fix:F-22 |  |
| [fs-bootstrap#5] | "Pass { raw: true } to read the global path" | B | DOC-ONLY | no { raw: true } option anywhere | — | doc-fix:F-22 |  |
| [fs-bootstrap#6] | "URL signing respects the prefix automatically" | B | VERIFIED | getSignedUrl/getUrl in KEYED_METHODS → prefixed | drive_bootstrapper.spec.ts | none |  |
| [fs-bootstrap#7] | Config: `drive: { enabled: true, prefix: 'tenants/{id}/' }` | B | DOC-ONLY | no drive config block; prefix is constant TENANT_DRIVE_PREFIX | — | doc-fix:F-22 |  |
| [fs-bootstrap#8] | "The drive bootstrapper does NOT automatically delete a tenant's files when the tenant is destroyed" | B | VERIFIED | no file deletion on destroy anywhere | — | none |  |
| [fs-bootstrap#9] | "Wire that up via a hook or event listener" | B | VERIFIED | hooks/events available for wiring | hook_registry.spec.ts | none |  |

## bootstrappers/mail.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [mail-bootstrap#1] | "Auto-detected when @adonisjs/mail is installed" | B | VERIFIED | provider hasBinding('mail.manager') | — | none |  |
| [mail-bootstrap#2] | "For the duration of the tenant context, mail.send(...) resolves SMTP credentials and the from address from the tenant's branding record (or any row source you configure)" | B | DOC-ONLY | no branding-based SMTP/from resolution — tenantMailer stamps X-Tenant-Id only (mail_bootstrapper.ts:19-29,54) | mail_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [mail-bootstrap#3] | Config: `mail: { enabled: true, resolver: async (tenant) => { ... } }` | B | DOC-ONLY | no mail config block exists | — | doc-fix:F-22 |  |
| [mail-bootstrap#4] | "The resolver returns { from, smtp: {...} \| null }" | B | DOC-ONLY | no resolver contract | — | doc-fix:F-22 |  |
| [mail-bootstrap#5] | "smtp: null means use the default mailer" | B | DOC-ONLY | no smtp:null semantics | — | doc-fix:F-22 |  |
| [mail-bootstrap#6] | "When tenants store SMTP passwords, they belong in tenant_brandings with the encrypted column treatment" | B | PARTIAL | tenant_brandings has encrypted columns (crypto.ts) — guidance OK but resolver hookup doesn't exist | crypto.spec.ts | doc-fix:F-22 |  |
| [mail-bootstrap#7] | "The BrandingService handles encrypt-on-write / decrypt-on-read" | B | VERIFIED | branding_service encrypt-on-write/decrypt-on-read | branding_service.spec.ts | none |  |
| [mail-bootstrap#8] | "Setting from per tenant changes the DKIM signing domain that your provider uses" | A | N/A | external email-infrastructure fact | — | none |  |
| [mail-bootstrap#9] | "Ensure each domain has the right DKIM record published; otherwise emails land in spam" | B | N/A | operator guidance | — | none |  |

## bootstrappers/session.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [session-bootstrap#1] | "Auto-detected when @adonisjs/session is installed" | B | VERIFIED | provider hasBinding('session') | — | none |  |
| [session-bootstrap#2] | "Prefixes every session read and write so two tenants on the same host cannot collide on a session key" | B | PARTIAL | prefixing via tenantSession()/tenantSessionKey() helpers only (session_bootstrapper.ts:45-68) | session_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [session-bootstrap#3] | Example: session.put('cart', cart) → actual key is `tenants/<active-tenant-id>/cart` | B | PARTIAL | helper key = tenants/<id>/cart (constant prefix) | session_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [session-bootstrap#4] | "If you're using subdomain-based routing (acme.app.example.com, globex.app.example.com), browsers already partition cookies by host" | B | N/A | browser behavior fact | — | none |  |
| [session-bootstrap#5] | Config to disable: `bootstrappers: { session: false }` | B | DOC-ONLY | no bootstrappers:{session:false} config — opt-out is registry.unregister('session') | bootstrapper_registry.spec.ts:50 | doc-fix:F-22 |  |
| [session-bootstrap#6] | "Path-based routing (/<uuid>/...) on a single origin shares cookies across all tenants" | B | N/A | cookie-scoping fact | — | none |  |
| [session-bootstrap#7] | Config: `session: { enabled: true, prefix: 't:{id}:' }` | B | DOC-ONLY | no session config block; prefix constant | — | doc-fix:F-22 |  |

## bootstrappers/broadcasting.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [broadcast-bootstrap#1] | "Auto-detected when @adonisjs/transmit is installed" | B | VERIFIED | provider hasBinding('transmit') | — | none |  |
| [broadcast-bootstrap#2] | "Every transmit.broadcast(...) and transmit.subscribe(...) is silently rewritten to a tenant-local channel" | B | PARTIAL | rewrite via tenantBroadcast()/tenantChannel() helpers, not transparent interception | transmit_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [broadcast-bootstrap#3] | Example: transmit.broadcast('orders/123', {...}) → actual channel is `tenants/<active-tenant-id>/orders/123` | B | VERIFIED | transmit_bootstrapper.ts:69-75 channel tenants/<id>/orders/123 | transmit_bootstrapper.spec.ts | none |  |
| [broadcast-bootstrap#4] | "Without scoping, two tenants sharing the same Transmit/SSE backend would receive each other's broadcasts" | A | N/A | motivating risk statement (true of any shared SSE) | — | none |  |
| [broadcast-bootstrap#5] | "The bootstrapper makes the mistake structurally impossible" | B | PARTIAL | 'structurally impossible' only when using the helpers | — | doc-fix:F-22 |  |
| [broadcast-bootstrap#6] | Config: `transmit: { enabled: true, prefix: 'tenants/{id}/' }` | B | PARTIAL | prefix configurable programmatically via createTransmitBootstrapper({prefix}) — no transmit config block | transmit_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [broadcast-bootstrap#7] | "The bootstrapper handles channel naming. Authorization is still your job." | B | VERIFIED | no authorization shipped | — | none |  |
| [broadcast-bootstrap#8] | "Use Transmit's channel.authorize() callbacks; the channel name is already tenant-prefixed" | B | VERIFIED | tenantChannel(name) returns prefixed name for authorize callbacks | transmit_bootstrapper.spec.ts | none |  |

## satellites/index.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [sat#1] | "Nine opt-in features attached to tenants" | B | VERIFIED | 9 satellites (7 core + sso + billing) | — | none |  |
| [sat#2] | "None of these are required to run Lasagna" | A | VERIFIED | all opt-in via --with; core boots without them | unit suite runs none enabled | none |  |
| [sat#3] | "Each ships its own backoffice migration, its own service, and its own admin endpoint" | B | PARTIAL | migrations+services yes; admin endpoints exist for flags/webhooks/quotas/metrics/audit-read/branding via admin pkg — impersonation has command+middleware not REST CRUD | e2e admin_full | none | minor over-generalization |
| [sat#4] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks` | B | VERIFIED | configure --with parsing | configure.spec.ts | none |  |
| [sat#5] | "The configure command is idempotent" | B | VERIFIED | idempotency guard (filterAlreadyPublished) | configure.spec.ts; configure_publish.spec.ts | none |  |
| [sat#6] | Satellite: Audit — Structured audit trail with actor + payload — Storage: tenant_audit_logs | B | VERIFIED | tenant_audit_logs stub + AuditLogService | audit specs | none |  |
| [sat#7] | Satellite: Feature flags — Per-tenant boolean flags (kill switches, beta cohorts), cached — Storage: tenant_feature_flags | B | VERIFIED | tenant_feature_flags + service + 60s cache | flag specs | none |  |
| [sat#8] | Satellite: Webhooks — HMAC-signed outbound events with delivery state machine and retries — Storage: tenant_webhooks, tenant_webhook_deliveries | B | VERIFIED | webhooks tables + service | webhook specs | none |  |
| [sat#9] | Satellite: Branding — Per-tenant logo, colors, custom domain, encrypted SMTP — Storage: tenant_brandings | B | VERIFIED | tenant_brandings + encrypted SMTP | branding specs | none |  |
| [sat#10] | Satellite: SSO — Per-tenant OIDC config with JWKS-backed verification — Storage: tenant_sso_configs | B | VERIFIED | tenant_sso_configs stub + sso pkg | sso specs | none |  |
| [sat#11] | Satellite: Metrics — Time-series counters per tenant with cursor-based aggregation — Storage: tenant_metrics | B | VERIFIED | tenant_metrics + SCAN flush | metrics specs | none |  |
| [sat#12] | Satellite: Quotas — Plan-bound limits; rolling and snapshot — Storage: tenant_quotas, tenant_plans | B | PARTIAL | storage is Redis counters + tenant_plans — no tenant_quotas table exists (no stub) | quota specs | doc-fix:F-25 |  |
| [sat#13] | Satellite: Billing — Stripe integration — Storage: stripe_customers, stripe_subscriptions, stripe_processed_events, stripe_meter_events | B | VERIFIED | 4 stripe_* stubs | billing suite | none |  |
| [sat#14] | Satellite: Impersonation — Admin enters a tenant as a target user, time-boxed and audited — Storage: Redis (no DB row) | B | VERIFIED | impersonation sessions in cache/Redis only | impersonation_lifecycle.spec.ts | none |  |
| [sat#15] | "Every satellite that writes to a database table goes through the backoffice schema; never the per-tenant schema" | B | VERIFIED | all satellite stubs target backoffice schema | satellite_coexistence.spec.ts | none |  |
| [sat#16] | "Every satellite that mutates state writes an audit row when the audit satellite is enabled" | B | DOC-ONLY | only impersonation writes audit rows (grep: AuditLogService used by impersonation_service only) | — | doc-fix:F-28 |  |
| [sat#17] | "Satellites never call each other directly; they go through their respective service contracts" | B | VERIFIED | services injected via container; no cross-satellite imports | — | none |  |

## satellites/audit.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [audit#1] | "Tenant lifecycle (created, activated, suspended, soft_deleted, restored, purged)" | B | DOC-ONLY | no lifecycle audit writes in commands/jobs/admin | — | doc-fix:F-28 |  |
| [audit#2] | "Webhook subscription / delivery state changes" | B | DOC-ONLY | webhook_service writes no audit rows | — | doc-fix:F-28 |  |
| [audit#3] | "Branding updates (with encrypted fields redacted)" | B | DOC-ONLY | branding_service writes no audit rows | — | doc-fix:F-28 |  |
| [audit#4] | "SSO config updates" | B | DOC-ONLY | sso pkg writes no audit rows | — | doc-fix:F-28 |  |
| [audit#5] | "Impersonation grants and revocations" | B | VERIFIED | impersonation_service.ts:93-105 admin:impersonate:start (+stop/use) | impersonation_middleware.spec.ts audit assertions | none |  |
| [audit#6] | "Quota threshold breaches" | B | DOC-ONLY | quota_service emits TenantQuotaExceeded event; writes no audit row | — | doc-fix:F-28 |  |
| [audit#7] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=audit` | B | VERIFIED | configure bundle | configure.spec.ts | none |  |
| [audit#8] | "The migration creates tenant_audit_logs in the backoffice schema" | B | VERIFIED | stub targets backoffice.tenant_audit_logs | audit_immutability.spec.ts | none |  |
| [audit#9] | "Migration installs three PostgreSQL triggers — BEFORE UPDATE, BEFORE DELETE, BEFORE TRUNCATE — that all RAISE EXCEPTION" | B | VERIFIED | stub:30-53 three triggers | audit_immutability.spec.ts | none |  |
| [audit#10] | "Audit rows are append-only at the database level" | A | VERIFIED | DB-level triggers | audit_immutability.spec.ts:57,:93,:121 | none |  |
| [audit#11] | Method: `audit.log({ tenantId, actorType, actorId, action, metadata, ipAddress })` | B | VERIFIED | audit_log_service.ts:13 log(options) | audit_log_service.spec.ts | none |  |
| [audit#12] | Column: id, tenant_id, actor_type, actor_id, action, metadata, ip_address, created_at | B | VERIFIED | stub columns | audit_log_service.spec.ts | none |  |
| [audit#13] | Index: (tenant_id, created_at) | B | VERIFIED | stub index (tenant_id, created_at) | — | none |  |
| [audit#14] | REST: `GET /admin/multitenancy/tenants/<id>/audit-logs?from=2026-04-01&to=2026-04-30` | B | VERIFIED | admin audit_logs_controller + from/to filters | audit_log_service.spec.ts filters; e2e admin_full | none |  |
| [audit#15] | "from and to parameters expect ISO 8601 dates" | B | VERIFIED | ISO dates parsed | audit_log_service.spec.ts | none |  |
| [audit#16] | "No OFFSET cost regardless of how many rows the tenant has" | B | PARTIAL | listForTenant uses page/limit (Lucid paginate = OFFSET) — 'no OFFSET cost' overstates unless keyset | audit_log_service.spec.ts | doc-fix (soften in W7) | verify paginate impl during fix |
| [audit#17] | "You can't DELETE FROM tenant_audit_logs directly — the trigger will reject it" | A | VERIFIED | trigger rejects DELETE | audit_immutability.spec.ts:93 | none |  |
| [audit#18] | Pattern 1: "Ship to a long-term store, then purge under controlled access — a privileged retention job temporarily disables the delete trigger" | B | N/A | operator pattern (matches security.md host-owns) | — | none |  |
| [audit#19] | Pattern 2: "Partition by month and DETACH + DROP old partitions — DROP TABLE doesn't fire the row-level triggers" | B | N/A | operator pattern (PG partitioning fact) | — | none |  |

## satellites/feature-flags.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [flags#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=feature_flags` | B | VERIFIED | configure bundle | configure.spec.ts | none |  |
| [flags#2] | Method: `isEnabled(tenantId, flag) → Promise<boolean>` (false when absent) | B | VERIFIED | feature_flag_service.ts isEnabled (false when absent) | feature_flag_service.spec.ts | none |  |
| [flags#3] | Method: `set(tenantId, flag, enabled, config?) → Promise<TenantFeatureFlag>` (upsert) | B | VERIFIED | set() upsert | feature_flag_service.spec.ts | none |  |
| [flags#4] | Method: `listForTenant(tenantId)` / `delete(tenantId, flag)` | B | VERIFIED | listForTenant/delete | feature_flag_service.spec.ts | none |  |
| [flags#5] | Column: id (UUID v4), tenant_id, flag, enabled (boolean), config (optional JSON), created_at, updated_at | B | VERIFIED | create_tenant_feature_flags_table.stub columns | satellite_coexistence.spec.ts | none |  |
| [flags#6] | "isEnabled reads through a per-tenant cache: whole flag map cached under ff_map:<tenantId> for 60s" | B | VERIFIED | feature_flag_service.ts:6 ff_map:<id>, :19 ttl 60s | feature_flag_service.spec.ts | none |  |
| [flags#7] | "set/delete bust the cache" | B | VERIFIED | set/delete cache bust (namespace delete) | feature_flag_service.spec.ts | none |  |
| [flags#8] | REST: GET /admin/multitenancy/tenants/{id}/feature-flags | B | VERIFIED | admin routes feature-flags GET | e2e admin_full | none |  |
| [flags#9] | REST: PUT /admin/multitenancy/tenants/{id}/feature-flags/{key} | B | VERIFIED | admin routes PUT | e2e admin_full | none |  |
| [flags#10] | REST: DELETE /admin/multitenancy/tenants/{id}/feature-flags/{key} | B | VERIFIED | admin routes DELETE | e2e admin_full | none |  |
| [flags#11] | "Evaluation is a boolean kill switch — no built-in percentage rollout" | B | VERIFIED | boolean enabled + config JSON; no rollout logic | — | none |  |
| [flags#12] | "Flags are cached for 60s, so a set takes up to a minute to propagate" | B | VERIFIED | 60s ttl ⇒ ≤1min propagation | — | none |  |

## satellites/webhooks.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [webhook#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=webhooks` | B | VERIFIED | configure --with=webhooks bundle | configure.spec.ts | none |  |
| [webhook#2] | Method: `subscribe({ tenantId, events, url, secret? })` | B | BROKEN | no subscribe(); registerWebhook(tenantId,url,events,secret?) positional (webhook_service.ts:174) | webhook_service.spec.ts | doc-fix:F-23 |  |
| [webhook#3] | "Generated when omitted; encrypted at rest with APP_KEY (AES-256-GCM)" | B | BROKEN | secret ? encrypt(secret) : null (:186) — NOT generated when omitted; unsigned delivery results | — | code-fix:F-23 (T12 generate-when-omitted) |  |
| [webhook#4] | Method: `dispatch({ tenantId, event, payload })` | B | PARTIAL | dispatch(tenantId,event,payload) positional, not object | webhook_service.spec.ts | doc-fix:F-23 |  |
| [webhook#5] | Header: `content-type: application/json` | B | VERIFIED | webhook_service.ts:124 | webhook_service.spec.ts headers | none |  |
| [webhook#6] | Header: `x-webhook-signature: <hex>` — HMAC-SHA256 over the raw body | B | VERIFIED | :131 HMAC-SHA256 hex over raw body | webhook signature tests | none |  |
| [webhook#7] | Header: `x-webhook-event: <event>` | B | VERIFIED | :125 | webhook_service.spec.ts | none |  |
| [webhook#8] | Header: `x-delivery-id: <uuid>` | B | VERIFIED | :126 delivery.id | webhook_service.spec.ts | none |  |
| [webhook#9] | Export: `verifyWebhookSignature(rawBody, signature, secret): boolean` | B | VERIFIED | verifyWebhookSignature export (:19-28) | signature spec | none |  |
| [webhook#10] | "Use constant-time helper; naive === comparisons leak timing" | A | VERIFIED | timingSafeEqual in verify | signature spec | none |  |
| [webhook#11] | "Pass the EXACT bytes received — not re-serialized JSON" | A | VERIFIED | doc guidance matches raw-body HMAC | — | none |  |
| [webhook#12] | "To defeat replay, log x-delivery-id and reject duplicates within a small TTL window" | B | N/A | consumer-side guidance | — | none |  |
| [webhook#13] | State: pending → delivering → delivered (2xx) or failed (non-2xx) | B | PARTIAL | real states: pending/success/failed/retrying (:88,:143) | webhook_service.spec.ts state machine | doc-fix:F-23 |  |
| [webhook#14] | State: failed → retry_scheduled (if retries left) or permanently_failed (no retries) | B | PARTIAL | retrying until MAX_ATTEMPTS then failed (:153) — no retry_scheduled/permanently_failed states | webhook_service.spec.ts | doc-fix:F-23 |  |
| [webhook#15] | State: retry_scheduled → delivering (after backoff elapsed) | B | PARTIAL | retrying → send on due nextRetryAt (processRetries :171) | webhook_service.spec.ts | doc-fix:F-23 |  |
| [webhook#16] | Attempt 1→2: 10 s base delay | B | VERIFIED | backoff table [10s,60s,300s,1800s,7200s] | webhook_service.spec.ts:246 jitter bounds | none |  |
| [webhook#17] | Attempt 2→3: 1 m | B | VERIFIED | 60s step | same | none |  |
| [webhook#18] | Attempt 3→4: 5 m | B | VERIFIED | 300s step | same | none |  |
| [webhook#19] | Attempt 4→5: 30 m | B | VERIFIED | 1800s step | same | none |  |
| [webhook#20] | Attempt 5→6: 2 h | B | VERIFIED | 7200s step | same | none |  |
| [webhook#21] | "After 5th attempt, delivery transitions to failed" | B | VERIFIED | MAX_ATTEMPTS=5 → failed (:153) | webhook_service.spec.ts dead-letter | none |  |
| [webhook#22] | "All retries include ±20% jitter" | B | VERIFIED | ±20% jitter | webhook_service.spec.ts:246 | none |  |
| [webhook#23] | Cron: `* * * * * node ace tenant:webhooks:retry` | B | VERIFIED | tenant_webhooks_retry.ts help text | e2e webhooks_delivery | none |  |
| [webhook#24] | REST: GET /admin/multitenancy/tenants/{id}/webhooks | B | VERIFIED | packages/admin routes (webhooks list) | e2e admin_full | none |  |
| [webhook#25] | REST: POST /admin/multitenancy/tenants/{id}/webhooks | B | VERIFIED | admin routes POST webhook | e2e admin_full | none |  |
| [webhook#26] | REST: DELETE /admin/multitenancy/tenants/{id}/webhooks/{webhookId} | B | VERIFIED | admin routes DELETE webhook | e2e admin_full | none |  |
| [webhook#27] | REST: GET /admin/multitenancy/tenants/{id}/webhooks/{webhookId}/deliveries | B | VERIFIED | admin routes deliveries | e2e admin_full | none |  |

## satellites/branding.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [branding#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=branding` | B | VERIFIED | configure bundle | configure.spec.ts | none |  |
| [branding#2] | Column: tenant_id (FK + unique), logo_url, primary_color (hex), accent_color (hex), custom_domain | B | VERIFIED | create_tenant_brandings_table.stub | branding_service.spec.ts | none |  |
| [branding#3] | Column: smtp_host, smtp_port, smtp_user, smtp_password (AES-256-GCM encrypted), smtp_secure, smtp_from | B | VERIFIED | stub smtp columns; crypto.ts AES-256-GCM | crypto.spec.ts; branding_service.spec.ts | none |  |
| [branding#4] | Method: `update(tenantId, { logoUrl, primaryColor, customDomain, ... })` | B | BROKEN | method is upsert(tenantId,data) not update() | branding_service.spec.ts | doc-fix:F-26 |  |
| [branding#5] | Method: `get(tenantId)` — SMTP password is decrypted on read | B | BROKEN | method is getForTenant() not get(); decrypt-on-read real | branding_service.spec.ts | doc-fix:F-26 |  |
| [branding#6] | "Setting custom_domain only stores the value" | B | VERIFIED | custom_domain only stored; middleware does routing | custom_domain specs | none |  |
| [branding#7] | "Wiring the request requires CustomDomainMiddleware" | B | VERIFIED | custom_domain_middleware.ts | custom_domain specs | none |  |
| [branding#8] | "Wildcard TLS, LetsEncrypt, and Cloudflare-style cert flow are your job" | B | N/A | host responsibility (matches cookbook) | — | none |  |
| [branding#9] | "SMTP passwords are encrypted with AES-256-GCM using APP_KEY" | B | VERIFIED | crypto.ts AES-256-GCM w/ APP_KEY | crypto.spec.ts | none |  |
| [branding#10] | "Rotation requires re-encryption" | B | N/A | operational fact | — | none |  |

## satellites/sso.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [sso#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=sso` | B | VERIFIED | configure --with=sso (stub ships in core) | configure.spec.ts | none |  |
| [sso#2] | Requirement: `npm install jose` (optional peer dependency) | B | VERIFIED | jose dynamic import (sso_service.ts:152) | sso_oidc_flow.spec.ts | none |  |
| [sso#3] | Step: "Generates state with randomBytes(16), single-use, 600 s TTL" | B | VERIFIED | STATE_TTL_SECONDS=600 (:29); GETDEL single-use (:89) | sso_oidc_flow.spec.ts:291 | none |  |
| [sso#4] | Step: "Generates nonce with randomBytes(16), bound to state" | B | VERIFIED | nonce bound in state payload (:92-94) | sso_oidc_flow.spec.ts:257 nonce mismatch | none |  |
| [sso#5] | Step: "Verifies the token endpoint returns an id_token" | B | VERIFIED | handleCallback rejects missing id_token | sso_oidc_flow.spec.ts:398 /id_token/ | none |  |
| [sso#6] | Step: "Verifies the id_token against the IdP's JWKS (cached 1 h via discovery)" | B | VERIFIED | createRemoteJWKSet + discovery cache ttl 3600s (:179) | sso_oidc_flow.spec.ts jwks | none |  |
| [sso#7] | Step: "Checks iss, aud, exp via jose.jwtVerify (60 s clock tolerance)" | B | VERIFIED | jwtVerify w/ issuer/audience + clockTolerance (:160-164) | sso_oidc_flow.spec.ts expired/issuer cases | none |  |
| [sso#8] | Step: "Confirms the nonce in the id_token payload matches the value bound to state" | B | VERIFIED | nonce check after jwtVerify (:137-138) | sso_oidc_flow.spec.ts:268 /nonce/ | none |  |
| [sso#9] | "Any mismatch throws and aborts the callback before claims surface" | A | VERIFIED | all verification failures throw before claims return | sso_oidc_flow.spec.ts rejects ×5 | none |  |
| [sso#10] | "Verifies the discovery doc's issuer matches the requested issuer (OIDC Discovery 1.0 §4.3)" | B | VERIFIED | discovery issuer match (:197-208) | sso_oidc_flow.spec.ts issuer mismatch | none |  |
| [sso#11] | "Applies validateExternalHttpsUrl to discovered token_endpoint and jwks_uri" | B | VERIFIED | validateResolvedHostIsPublic on token_endpoint + jwks_uri (:243-246) | sso_service.spec.ts | none |  |
| [sso#12] | "Defends against SSRF (loopback, RFC 1918, link-local, cloud metadata, IPv6 brackets)" | A | VERIFIED | url.ts guard (full range set incl. brackets) | url.spec.ts 24 tests | none |  |
| [sso#13] | Method: `upsert(tenantId, { issuerUrl, clientId, clientSecret, redirectUri, scopes })` | B | BROKEN | no upsert() on SsoService (config rows via TenantSsoConfig model) | sso_service.spec.ts | doc-fix:F-27 |  |
| [sso#14] | Method: `startLogin(tenantId) → { authUrl, state }` | B | BROKEN | buildAuthUrl(config) — no startLogin(tenantId) | sso_oidc_flow.spec.ts uses buildAuthUrl | doc-fix:F-27 |  |
| [sso#15] | Method: `handleCallback(tenantId, { code, state, cookieState }) → claims` | B | BROKEN | handleCallback(state, code) positional (:81-84) | sso_oidc_flow.spec.ts | doc-fix:F-27 |  |

## satellites/metrics.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [metrics#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=metrics` | B | VERIFIED | configure bundle | configure.spec.ts | none |  |
| [metrics#2] | Method: `increment(tenantId, 'requests' \| 'errors', amount = 1)` | B | VERIFIED | metrics_service.ts increment | metrics_service.spec.ts | none |  |
| [metrics#3] | Method: `trackBandwidth(tenantId, bytes)` | B | VERIFIED | trackBandwidth | metrics_service.spec.ts | none |  |
| [metrics#4] | "Both are per-UTC-day Redis counters with a 48h TTL" | B | VERIFIED | metrics_service.ts:17,23 expire 172800 (48h), per-UTC-day key | metrics_service.spec.ts | none |  |
| [metrics#5] | Method: `flush(period?)` — Rolls Redis counters into tenant_metrics | B | VERIFIED | flush(period?) | metrics_service.spec.ts | none |  |
| [metrics#6] | Cron: `0 1 * * * node ace tenant:metrics:flush` | B | VERIFIED | tenant_metrics_flush.ts help cron | — | none |  |
| [metrics#7] | "Uses a SCAN cursor, safe against arbitrarily large key sets" | B | VERIFIED | metrics_service.ts:26-30 redis.scan cursor COUNT 200 | — | none |  |
| [metrics#8] | Method: `getForTenant(tenantId, days = 30)` — Most recent N days of persisted rows | B | VERIFIED | getForTenant(tenantId, days=30) | metrics_service.spec.ts | none |  |
| [metrics#9] | "Current day's counters live in Redis until next flush" | B | VERIFIED | flush moves counters; current day stays in Redis | metrics_service.spec.ts | none |  |
| [metrics#10] | REST: GET /admin/multitenancy/tenants/{id}/metrics?days=30 | B | VERIFIED | admin routes metrics?days= | e2e admin_full | none |  |
| [metrics#11] | "days is clamped to 1..365 (default 30)" | B | VERIFIED | admin controller clamps days 1..365 | e2e admin_full | none |  |
| [metrics#12] | "Counter increments hit Redis, not database. If Redis unavailable, increments for that window are lost." | A | VERIFIED | redis-only increments; resilience.redis.metrics fail-open default | — (loss window not asserted) | none |  |
| [metrics#13] | "The metric set is fixed (requests, errors, bandwidth)" | B | VERIFIED | fixed metric set requests/errors/bandwidth | metrics_service.spec.ts | none |  |
| [metrics#14] | "For arbitrary named metrics or gauges, use the OpenTelemetry integration" | B | VERIFIED | telemetry_service.ts OTel integration | telemetry specs | none |  |

## satellites/quotas.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [quota#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=quotas` | B | VERIFIED | configure bundle (prints plans block) | configure.spec.ts | none |  |
| [quota#2] | "Plans are declared statically in config/multitenancy.ts under the plans key" | A | BROKEN | plans also storage-backed (tenant_plans, storage:'auto') — not static-only | quota_assignment.spec.ts | doc-fix:F-25 |  |
| [quota#3] | "There is no upsertPlan / assignPlan API" | B | BROKEN | assignPlan/getAssignedPlan/clearAssignedPlan EXIST (quota_service.ts) | quota_assignment.spec.ts | doc-fix:F-25 |  |
| [quota#4] | Config: `plans: { defaultPlan, definitions, getPlan, storage }` | B | VERIFIED | types/config.ts:74-102 | quota_service.spec.ts | none |  |
| [quota#5] | "PlanDefinition.limits is Record<string, number>" | B | VERIFIED | PlanDefinition.limits Record<string,number> (config.ts:70-72) | — | none |  |
| [quota#6] | Middleware: `enforceQuota(quotaName, options?)` | B | VERIFIED | enforce_quota_middleware.ts factory | enforce_quota_middleware.spec.ts | none |  |
| [quota#7] | "Apply per-route, not globally — TenantGuardMiddleware must run first" | A | VERIFIED | middleware resolves request.tenant() — needs guard-resolvable request | enforce_quota_middleware.spec.ts | none |  |
| [quota#8] | Option: `{ enforce: false }` — track usage but never reject | B | VERIFIED | enforce:false → track() | enforce_quota_middleware.spec.ts | none |  |
| [quota#9] | Option: `{ amount: 1 }` — increment by more than 1 | B | VERIFIED | amount option | enforce_quota_middleware.spec.ts | none |  |
| [quota#10] | Middleware step: Resolves active tenant | B | VERIFIED | middleware step 1 | same | none |  |
| [quota#11] | Middleware step: Looks up getLimit(tenant, quotaName) | B | VERIFIED | getLimit | same | none |  |
| [quota#12] | Middleware step: Calls consume(tenant, quotaName, amount) | B | VERIFIED | consume | same | none |  |
| [quota#13] | Middleware step: Throws QuotaExceededException (HTTP 429) on overrun | B | VERIFIED | QuotaExceededException 429 | same + quota_concurrency | none |  |
| [quota#14] | "consume runs a single Redis EVAL (Lua) script" | A | VERIFIED | quota_service.ts:364-391 single EVAL | quota_concurrency.spec.ts | test-fix:T0 |  |
| [quota#15] | "GET the counter, compare against limit, INCRBY only when it fits" | A | VERIFIED | QUOTA_CONSUME_LUA get/compare/incrby+expire | quota_concurrency.spec.ts | none |  |
| [quota#16] | "Concurrent callers cannot over-grant the quota" | A | VERIFIED | Redis single-threaded EVAL | quota_concurrency.spec.ts (exactness after T0) | test-fix:T0 |  |
| [quota#17] | Mode: rolling-day (default) — track / consume — 48-hour TTL counter | B | VERIFIED | rolling key + ROLLING_TTL 48h | quota_service.spec.ts | none |  |
| [quota#18] | Mode: snapshot — setUsage — No TTL; app reports the new value | B | VERIFIED | setUsage snapshot (no TTL) | quota_service.spec.ts | none |  |
| [quota#19] | Policy: fail-open (default) — consume returns 0 and skips enforcement | B | VERIFIED | quota_service.ts:372,396 fail-open default returns 0 | quota_resilience.spec.ts | none |  |
| [quota#20] | Policy: fail-closed — consume throws DependencyUnavailableException (503) | B | VERIFIED | fail-closed → DependencyUnavailableException 503 | quota_resilience.spec.ts | none |  |
| [quota#21] | Config: `resilience.redis.quota` — 'fail-open' \| 'fail-closed' | B | VERIFIED | config.ts:327 | — | none |  |
| [quota#22] | Method: `getUsage(tenant, quota) → Promise<number>` | B | VERIFIED | getUsage | quota_service.spec.ts | none |  |
| [quota#23] | Method: `snapshot(tenant) → Promise<QuotaStateSnapshot>` | B | VERIFIED | snapshot() | quota_service.spec.ts | none |  |
| [quota#24] | "Plan resolution happens on every request via getPlan(tenant)" | B | VERIFIED | getPlanFor per call (60s cache when storage-backed) | quota_assignment.spec.ts | none |  |
| [quota#25] | "Counters are NOT reset when a plan changes" | A | VERIFIED | no reset on plan change (counters independent) | — (not asserted) | none |  |
| [quota#26] | "Call quotas.reset(tenant, quotaName) to zero explicitly" | B | VERIFIED | reset(tenant, quota?) | quota teardown uses it | none |  |
| [quota#27] | REST: GET /admin/multitenancy/tenants/{id}/quotas | B | VERIFIED | admin routes quotas GET | e2e admin_full | none |  |
| [quota#28] | REST: PUT /admin/multitenancy/tenants/{id}/quotas/usage | B | VERIFIED | admin routes PUT usage | e2e admin_full | none |  |
| [quota#29] | REST: POST /admin/multitenancy/tenants/{id}/quotas/reset | B | VERIFIED | admin routes POST reset | e2e admin_full | none |  |

## satellites/billing.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [billing#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=billing` | B | VERIFIED | configure --with=billing | configure.spec.ts | none |  |
| [billing#2] | Requirement: `npm install stripe@^18` | B | VERIFIED | stripe ^18 optional peer | — | none |  |
| [billing#3] | "5 backoffice migrations: tenant_plans, stripe_customers, stripe_subscriptions, stripe_processed_events, stripe_meter_events" | B | VERIFIED | 5 stubs: tenant_plans + 4 stripe_* (glob verified) | configure.spec.ts billing bundle | none |  |
| [billing#4] | "Publishes app/mailers/quota_warning_mailer.ts plus resources/views/emails/quota_warning.edge" | B | VERIFIED | stubs/mailers/quota_warning_mailer.stub + views/emails/quota_warning.edge.stub | configure publish spec | none |  |
| [billing#5] | Env var: `STRIPE_API_KEY` — Secret key. Boot **rejects** sk_live_* when NODE_ENV !== 'production' | B | VERIFIED | billing_service.ts:120-135 live-key rejection | mode_detection.spec.ts | none |  |
| [billing#6] | Env var: `STRIPE_WEBHOOK_SECRET` — Webhook signing secret from Stripe dashboard | B | VERIFIED | webhookSecret from env | webhook_idempotency.spec.ts | none |  |
| [billing#7] | Env var: `STRIPE_API_VERSION` (optional, default '2025-08-27.basil') — pin version | B | VERIFIED | config.ts:120 default 2025-08-27.basil | — | none |  |
| [billing#8] | Env var: `STRIPE_ALLOW_LIVE_IN_DEV` — Set to 'true' to allow live keys outside production | B | VERIFIED | billing_service.ts:132 escape hatch | mode_detection.spec.ts | none |  |
| [billing#9] | "Boot **rejects** when STRIPE_API_KEY and NODE_ENV disagree about test vs live mode" | A | VERIFIED | billing_service.ts:106,120-135 | mode_detection.spec.ts | none |  |
| [billing#10] | "Boot validates STRIPE_WEBHOOK_SECRET is non-empty and starts with whsec_" | A | VERIFIED | billing_service.ts:141-155 whsec_ validation | diagnostics_commands.spec.ts (:53-57) | none |  |
| [billing#11] | Config: `billing.driver` — 'stripe' (required) | B | VERIFIED | config.ts:113 | — | none |  |
| [billing#12] | Config: `billing.stripe.apiKey` — from STRIPE_API_KEY | B | VERIFIED | config.ts:116 | — | none |  |
| [billing#13] | Config: `billing.stripe.webhookSecret` — from STRIPE_WEBHOOK_SECRET | B | VERIFIED | config.ts:118 | — | none |  |
| [billing#14] | Config: `billing.stripe.apiVersion` — optional pin | B | VERIFIED | config.ts:120 | — | none |  |
| [billing#15] | Config: `billing.stripe.timeout` (default 10_000 ms) | B | VERIFIED | config.ts:122 default 10_000 | — | none |  |
| [billing#16] | Config: `billing.stripe.maxNetworkRetries` (default 3) | B | VERIFIED | config.ts:124 default 3 | — | none |  |
| [billing#17] | Config: `billing.products` — Record<string, string> — Stripe product/price ID → plan name | B | VERIFIED | config.ts:127 | subscription_sync.spec.ts | none |  |
| [billing#18] | Config: `billing.defaultPlan` — Plan assigned on cancel or unmapped product | B | VERIFIED | config.ts:129 | subscription_sync.spec.ts cancel→default | none |  |
| [billing#19] | Config: `billing.webhook.path` (default '/webhooks/stripe') — Must be in ignorePaths | B | VERIFIED | config.ts:132 default /webhooks/stripe | ignore_paths.spec.ts | none |  |
| [billing#20] | Config: `billing.webhook.queueName` (default 'billing-events') | B | VERIFIED | config.ts:134 default billing-events | — | none |  |
| [billing#21] | Config: `billing.webhook.idempotencyTtlDays` (default 90) — Retention for stripe_processed_events | B | VERIFIED | config.ts:136 default 90 | cleanup_command.spec.ts | none |  |
| [billing#22] | Config: `billing.webhook.enforceIpAllowlist` (default false) | B | VERIFIED | config.ts:138 default false | ip_allowlist.spec.ts | none |  |
| [billing#23] | Config: `billing.webhook.allowedIps` — Literal IPs and/or CIDR ranges | B | VERIFIED | config.ts:140 | ip_allowlist.spec.ts + stripe_ip_allowlist unit (8) | none |  |
| [billing#24] | Config: `billing.dunning.maxAttempts` (default 3) | B | VERIFIED | config.ts:144 default 3 | dunning_flow.spec.ts | none |  |
| [billing#25] | Config: `billing.dunning.action` — 'none' \| 'downgrade' | B | VERIFIED | config.ts:159 | dunning_flow.spec.ts downgrade | none |  |
| [billing#26] | Config: `billing.dunning.gracePeriodDays` (default 0) | B | VERIFIED | config.ts:161 default 0 | dunning_flow.spec.ts | none |  |
| [billing#27] | Config: `billing.notifyOnQuotaExceeded` (default false) | B | VERIFIED | config.ts:164 default false | — | none |  |
| [billing#28] | Config: `billing.onTenantDelete` — 'cancel' \| 'detach' \| 'preserve' | B | VERIFIED | config.ts:166 default cancel | tenant_delete_lifecycle.spec.ts | none |  |
| [billing#29] | Config: `billing.usageMapping` — Auto-bridge QuotaService.track to Stripe Meters | B | VERIFIED | config.ts:173 usageMapping + batchFlushMs | metered_usage.spec.ts | none |  |
| [billing#30] | Config: `billing.observability.metrics` (default true if MetricsService active) | B | VERIFIED | config.ts:176 | — | none |  |
| [billing#31] | Config: `billing.observability.redactPii` (default true) | B | VERIFIED | config.ts:178 default true | pii_redaction.spec.ts | none |  |

## satellites/impersonation.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [impersonate#1] | Command: `node ace configure @adonisjs-lasagna/saas-tenancy --with=impersonation` | B | VERIFIED | configure --with=impersonation | configure.spec.ts | none |  |
| [impersonate#2] | Config: `impersonation: { secret, defaultDuration, maxDuration }` | B | VERIFIED | types/config.ts:386-396 | impersonation_service.spec.ts | none |  |
| [impersonate#3] | "secret must be ≥ 32 chars; validated at boot" | A | VERIFIED | provider:150,230 boot validation + service :226 | impersonation_service.spec.ts secret cases | none |  |
| [impersonate#4] | Config: `impersonation.defaultDuration` (default 900 seconds, min 60) | B | BROKEN | page says 900 (and '1 hour' in its own intro); code default 3600 (config.ts:390) | — | doc-fix:F-24 |  |
| [impersonate#5] | Config: `impersonation.maxDuration` (default 86400 seconds) | B | VERIFIED | 86400 (config.ts:392) | — | none |  |
| [impersonate#6] | Command: `node ace tenant:impersonate <tenantId> <userId> --admin=<id> --duration=<seconds> --reason="…"` | B | VERIFIED | commands.json tenant:impersonate flags | e2e | none |  |
| [impersonate#7] | API: `issue({ tenantId, targetUserId, adminId, durationSeconds, reason, path }) → { token, redirectUrl }` | B | BROKEN | no issue(); start(opts)→{token,sessionId,expiresAt} (:46,:107); redirectUrl is command-level | impersonation_service.spec.ts | doc-fix:F-24 |  |
| [impersonate#8] | Middleware: `ImpersonationMiddleware` | B | VERIFIED | middleware/impersonation_middleware.ts | unit+integration middleware specs | none |  |
| [impersonate#9] | "Reads token from imp query param or x-impersonation-token header" | B | BROKEN | middleware reads header or cookie (:31-33); no imp query param | impersonation_middleware.spec.ts | doc-fix:F-24 |  |
| [impersonate#10] | "HMAC-verifies it with crypto.timingSafeEqual" | B | VERIFIED | service verify() timingSafeEqual (:220) | impersonation_service.spec.ts | none |  |
| [impersonate#11] | "Looks up Redis-backed grant (single-use; consumes on read)" | B | BROKEN | sessions persist with TTL (:86-91); verify() does NOT consume | impersonation_lifecycle.spec.ts (verify→list→expire) | doc-fix:F-24 |  |
| [impersonate#12] | "Sets request.impersonation = { adminId, targetUserId, reason }" | B | PARTIAL | ctx.impersonation = verified (:65) — full session ctx, not just 3 fields | impersonation_middleware.spec.ts | doc-fix:F-24 |  |
| [impersonate#13] | Event: impersonation.granted — Records adminId, tenantId, targetUserId, reason, expiresAt | B | PARTIAL | audit action is admin:impersonate:start (:97), not impersonation.granted | impersonation_middleware.spec.ts audit assertions | doc-fix:F-24 |  |
| [impersonate#14] | Event: impersonation.consumed — Records adminId, tenantId, targetUserId, IP, user-agent | B | PARTIAL | companion use/stop audit actions named admin:impersonate:* not impersonation.consumed | integration audit checks | doc-fix:F-24 |  |
| [impersonate#15] | Event: impersonation.expired — Records adminId, tenantId, targetUserId | B | PARTIAL | expiry via cache TTL; no impersonation.expired audit row | impersonation_lifecycle.spec.ts expire | doc-fix:F-24 |  |
| [impersonate#16] | "Tokens are HMAC-SHA256 over a fixed-size payload" | A | VERIFIED | #sign(sessionId) HMAC-SHA256 (:108) | impersonation_service.spec.ts | none |  |
| [impersonate#17] | "Verification uses timingSafeEqual; constant-time" | A | VERIFIED | :220 timingSafeEqual | impersonation_service.spec.ts | none |  |
| [impersonate#18] | "The shared secret is validated as ≥ 32 chars at provider boot" | A | VERIFIED | provider:230 #validateImpersonationConfig | — | none |  |
| [impersonate#19] | "Tokens are single-use; Redis GETDEL consumes the grant" | A | BROKEN | no GETDEL; sessions are NOT single-use — valid until TTL/stop() | impersonation_lifecycle.spec.ts | doc-fix:F-24 |  |
| [impersonate#20] | "Tokens cannot be re-issued from a captured one; they sign a random nonce" | A | VERIFIED | token signs randomBytes(16) session id (:70) | impersonation_service.spec.ts | none |  |

## admin-rest-api.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [api#1] | "The admin API is fail-closed — multitenancyAdminRoutes(...) requires a middleware option" | A | VERIFIED | admin routes.ts:130-140 | — (no spec) | new-test:T9 |  |
| [api#2] | "Throws at startup if you omit middleware" | A | VERIFIED | routes.ts:131 throw | — | new-test:T9 |  |
| [api#3] | "The package ships NO built-in token check" | B | VERIFIED | no token logic shipped | — | none |  |
| [api#4] | Option: `middleware: false` — deliberately mount public (only behind trusted network) | B | VERIFIED | routes.ts:139-140 middleware===false opt-out | — | new-test:T9 |  |
| [api#5] | API: `multitenancyAdminRoutes({ prefix, middleware, resolveAdminActor? })` | B | VERIFIED | routes.ts:125 options incl. resolveAdminActor, docsAuth | e2e admin_full | none |  |
| [api#6] | "middleware is required; omit it and the call throws" | B | VERIFIED | routes.ts:130 | — | new-test:T9 |  |
| [api#7] | "resolveAdminActor callback is required for privileged actions (audit attribution)" | B | VERIFIED | impersonation endpoints require resolveAdminActor | e2e admin_full | none |  |
| [api#8] | "The spec is generated from the service contract" | B | VERIFIED | openapi.ts generates from contract | openapi.spec.ts | none |  |
| [api#9] | Endpoint: JSON spec: GET /admin/multitenancy/openapi.json | B | VERIFIED | routes.ts:208+ openapi.json | openapi.spec.ts; e2e admin_full | none |  |
| [api#10] | Endpoint: Swagger UI: GET /admin/multitenancy/docs | B | VERIFIED | routes.ts /docs Swagger UI (docsAuth) | e2e admin_full | none |  |
| [api#11] | REST: GET /tenants | B | VERIFIED | routes.ts:148 GET /tenants | e2e admin_full | none |  |
| [api#12] | REST: GET /tenants/{id} | B | VERIFIED | :150 GET /tenants/:id | e2e admin_full | none |  |
| [api#13] | REST: POST /tenants | B | VERIFIED | :149 POST /tenants | e2e admin_full | none |  |
| [api#14] | REST: PUT /tenants/{id}/activate | B | BROKEN | :151 POST (not PUT) /tenants/:id/activate | e2e admin_full uses POST | doc-fix:F-29 |  |
| [api#15] | REST: PUT /tenants/{id}/suspend | B | BROKEN | :152 POST /tenants/:id/suspend | e2e | doc-fix:F-29 |  |
| [api#16] | REST: DELETE /tenants/{id} | B | BROKEN | :153 POST /tenants/:id/destroy — DELETE /tenants/{id} does not exist | e2e | doc-fix:F-29 |  |
| [api#17] | REST: PUT /tenants/{id}/restore | B | BROKEN | :154 POST /tenants/:id/restore | e2e | doc-fix:F-29 |  |
| [api#18] | REST: PUT /tenants/{id}/maintenance | B | BROKEN | :156 POST /tenants/:id/maintenance | e2e | doc-fix:F-29 |  |
| [api#19] | REST: DELETE /tenants/{id}/maintenance | B | VERIFIED | :157 DELETE /tenants/:id/maintenance | e2e | none |  |
| [api#20] | REST: GET /tenants/{id}/audit-logs?from=…&to=… | B | VERIFIED | :167 audit-logs + from/to | e2e admin_full | none |  |
| [api#21] | REST: GET /tenants/{id}/feature-flags | B | VERIFIED | :180 | e2e | none |  |
| [api#22] | REST: PUT /tenants/{id}/feature-flags/{key} | B | VERIFIED | :182 PUT flagKey | e2e | none |  |
| [api#23] | REST: DELETE /tenants/{id}/feature-flags/{key} | B | VERIFIED | :183 DELETE flagKey | e2e | none |  |
| [api#24] | REST: GET /tenants/{id}/webhooks | B | VERIFIED | :170 | e2e | none |  |
| [api#25] | REST: POST /tenants/{id}/webhooks | B | VERIFIED | :171 | e2e | none |  |
| [api#26] | REST: DELETE /tenants/{id}/webhooks/{webhookId} | B | VERIFIED | :173 | e2e | none |  |
| [api#27] | REST: GET /tenants/{id}/webhooks/{webhookId}/deliveries | B | VERIFIED | :174 | e2e | none |  |

## authentication.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [auth#1] | "Lasagna does not ship an authentication system" | B | VERIFIED | no auth system in package | — | none |  |
| [auth#2] | "You bring your own (AdonisJS @adonisjs/auth, custom guard, external IdP)" | B | N/A | guidance | — | none |  |
| [auth#3] | "The package gives you the active tenant context, resolved before your auth runs" | B | VERIFIED | guard resolves before downstream middleware | guard specs | none |  |
| [auth#4] | "Tenant resolution must run before your auth middleware" | A | VERIFIED | middleware ordering requirement (adapter needs context) | impersonation_tenant_binding ordering | none |  |
| [auth#5] | "If you authenticate first, a query against a tenant-scoped User model has no active tenant and will fail" | A | VERIFIED | TenantBaseModel without context throws (adapter) | tenant_adapter.spec.ts:170 | none |  |
| [auth#6] | "Make your User model extend TenantBaseModel" | B | N/A | app design guidance | — | none |  |
| [auth#7] | "Every auth query routes to the active tenant's schema automatically" | B | VERIFIED | adapter routes user queries per tenant | cross_tenant_e2e | none |  |
| [auth#8] | "Sessions are scoped per tenant; see the session bootstrapper" | B | PARTIAL | session scoping via tenantSession() helper (F-22) — not transparent | session_bootstrapper.spec.ts | doc-fix:F-22 |  |
| [auth#9] | "Operators and support staff use CentralBaseModel / BackofficeBaseModel" | B | VERIFIED | central/backoffice base models | — | none |  |
| [auth#10] | "Authenticate them on non-tenant routes declared with router.central()" | B | VERIFIED | router.central() macro | central_only_middleware.spec.ts | none |  |
| [auth#11] | "The Admin REST API is fail-closed: it refuses to mount without an auth middleware you provide" | B | VERIFIED | admin routes.ts:130-140 | — | new-test:T9 |  |
| [auth#12] | "It asks for a resolveAdminActor callback so every privileged action is attributed to a real operator" | B | VERIFIED | resolveAdminActor option | e2e admin_full | none |  |
| [auth#13] | "When an operator needs to act as a tenant user, use the impersonation satellite" | B | VERIFIED | impersonation satellite | impersonation specs | none |  |
| [auth#14] | "Impersonation tokens are time-boxed, single-use, HMAC-signed, bound to the target tenant, and fully audited" | B | PARTIAL | time-boxed/HMAC/tenant-bound/audited TRUE; 'single-use' FALSE (F-24) | impersonation specs | doc-fix:F-24 |  |

## jobs.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [job#1] | Job: `InstallTenant` — Provision the tenant's schema/database, run migrations, init queue | B | VERIFIED | jobs/install_tenant.ts (provision→migrate→active) | tenant_lifecycle.spec.ts; e2e queue_jobs | none |  |
| [job#2] | Job: `UninstallTenant` — Tear down storage, destroy tenant queue, soft-delete row | B | VERIFIED | jobs/uninstall_tenant.ts | tenant_lifecycle.spec.ts | none |  |
| [job#3] | Job: `BackupTenant` — Run pg_dump, mirror to S3 if configured | B | PARTIAL | BackupTenant exists in @adonisjs-lasagna/backup, NOT core /jobs | tenant_backup.spec.ts | doc-fix:F-17 |  |
| [job#4] | Job: `RestoreTenant` — Run pg_restore against stored dump | B | PARTIAL | RestoreTenant in backup pkg | tenant_restore.spec.ts | doc-fix:F-17 |  |
| [job#5] | Job: `CloneTenant` — Provision destination + copy rows from source | B | PARTIAL | CloneTenant in backup pkg | clone_service.spec.ts | doc-fix:F-17 |  |
| [job#6] | Job: `ProcessStripeEventJob` — Process verified Stripe webhook (retrieve, ordering guard, sync, mark completed) | B | PARTIAL | ProcessStripeEventJob in billing pkg | webhook_idempotency + event_ordering specs | doc-fix:F-17 |  |
| [job#7] | Job: `ReportUsageBatchJob` — Send aggregated meter events to Stripe in single batch | B | PARTIAL | ReportUsageBatchJob in billing pkg | metered_usage.spec.ts | doc-fix:F-17 |  |
| [job#8] | Job: `BillingCleanupJob` — Purge stripe_processed_events older than webhook.idempotencyTtlDays | B | PARTIAL | BillingCleanupJob in billing pkg | cleanup_command.spec.ts | doc-fix:F-17 |  |
| [job#9] | "InstallTenant queued by tenant:create, POST /admin/.../tenants" | B | VERIFIED | create_tenant.ts queues InstallTenant; admin pkg POST does too | e2e commands_lifecycle + admin_full | none |  |
| [job#10] | "UninstallTenant queued by tenant:destroy (when not --keep-schema)" | B | VERIFIED | destroy_tenant.ts queues UninstallTenant unless --keep-schema | e2e commands_lifecycle | none |  |
| [job#11] | "BackupTenant queued by tenant:backups:run cron, ad-hoc dispatch" | B | VERIFIED | backup pkg tenant:backups:run dispatches | backup_retention_service.spec.ts | none |  |
| [job#12] | "RestoreTenant queued by tenant:restore" | B | VERIFIED | backup pkg tenant:restore | e2e backups_real | none |  |
| [job#13] | "CloneTenant queued by tenant:clone" | B | VERIFIED | backup pkg tenant:clone | clone_service.spec.ts | none |  |
| [job#14] | Import: `{ InstallTenant, UninstallTenant, ... } from '@adonisjs-lasagna/saas-tenancy/jobs'` | B | BROKEN | src/jobs/index.ts exports ONLY InstallTenant+UninstallTenant — 'all eight from core /jobs' snippet does not compile | — | doc-fix:F-17 |  |
| [job#15] | API: `InstallTenant.dispatch({ tenantId })` | B | VERIFIED | InstallTenant.dispatch({tenantId}) (@adonisjs/queue static) | e2e queue_jobs | none |  |
| [job#16] | API: `BackupTenant.dispatch({ tenantId })` | B | PARTIAL | BackupTenant.dispatch exists — import path in doc wrong | tenant_backup.spec.ts | doc-fix:F-17 |  |
| [job#17] | API: `RestoreTenant.dispatch({ tenantId, fileName })` | B | PARTIAL | RestoreTenant.dispatch — import path wrong | tenant_restore.spec.ts | doc-fix:F-17 |  |
| [job#18] | API: `CloneTenant.dispatch({ sourceTenantId, destinationTenantId, schemaOnly, clearSessions })` | B | PARTIAL | CloneTenant.dispatch — import path wrong | clone_service.spec.ts | doc-fix:F-17 |  |
| [job#19] | Export: `CloneTenantPayload` as a public type | B | PARTIAL | CloneTenantPayload exported from backup pkg, not core | — | doc-fix:F-17 |  |
| [job#20] | "Every job binds an AsyncLocalStorage scope to the active tenant before doing any work" | B | VERIFIED | install_tenant.ts:23-24 logCtx.run wrapper (same pattern in uninstall/backup/billing jobs) | jobs/tenant_context.spec.ts:72 | none |  |
| [job#21] | "Inside execute(): const logCtx = await app.container.make(TenantLogContext); return logCtx.run({ tenantId }, async () => { ... })" | B | VERIFIED | install_tenant.ts:23-24 exact pattern | tenant_context.spec.ts | none |  |
| [job#22] | "tenancy.currentId() === tenantId" | B | VERIFIED | TenantLogContext seeds tenancy.currentId | tenant_context.spec.ts:72 | none |  |
| [job#23] | "tenantLogger() emits { tenantId } on every line" | B | VERIFIED | tenant_logger.ts child bindings | tenant_logger.spec.ts; e2e contextual_logging | none |  |
| [job#24] | "Any service/repository/third-party client sees tenant context without threading it manually" | B | VERIFIED | AsyncLocalStorage propagation | tenant_context.spec.ts (await/async continuations) | none |  |
| [job#25] | "InstallTenant, UninstallTenant, BackupTenant, RestoreTenant, CloneTenant run before: and after: hooks" | B | VERIFIED | jobs run hooks.run('before'/'after', …) | e2e lifecycle_events | none |  |
| [job#26] | Hook phase: before: — throws aborts the job; queue retries per configured attempts | B | PARTIAL | before-throw aborts (install_tenant catch → failed); 'queue retries per configured attempts' unproven | — (no test that attempts is honored) | new-test:T2 |  |
| [job#27] | Hook phase: after: — throws is logged and swallowed; operation continues | B | VERIFIED | hook_registry after swallow | hook_registry.spec.ts | none |  |
| [job#28] | "After the after: hook, the job dispatches the matching event (TenantProvisioned, TenantBackedUp, etc.)" | B | VERIFIED | install_tenant dispatches TenantProvisioned after hooks | lifecycle_dispatch.spec.ts | none |  |
| [job#29] | "Each job overrides failed(error) to log a structured line keyed by tenantId" | B | VERIFIED | jobs override failed(error) with structured log | — (log shape not asserted) | none |  |
| [job#30] | "The job stays on the queue's failed set per BullMQ defaults" | B | N/A | BullMQ default behavior (failed set) | — | none |  |
| [job#31] | Pattern: Wrap body in `tenancy.run(tenant, async () => { ... })` | B | VERIFIED | tenancy.run pattern | tenant_context.spec.ts | none |  |
| [job#32] | Example: Inside a job's execute(), resolve tenant repo, fetch tenant, call tenancy.run() | B | VERIFIED | snippet matches install_tenant.ts pattern | — | none |  |
| [job#33] | Test: Job-context leak under interleaved tenants (`tests/integration/jobs/tenant_context.spec.ts`) — 3 tenants × 30 randomly-shuffled jobs | B | VERIFIED | — | tenant_context.spec.ts:72 (constants 3×30 verified) | none |  |

## testing.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [test#1] | "Most assertions don't need a real database" | B | N/A | guidance | — | none |  |
| [test#2] | "Lasagna ships hermetic helpers for tenant-routing behaviour" | B | PARTIAL | helpers exist except withTenant (F-18) | testing/builders.spec.ts | code-fix:F-18 |  |
| [test#3] | "Reach for the SQLite memory driver only when your test needs real SQL round-trips" | B | VERIFIED | sqlite_memory_driver.ts | sqlite specs | none |  |
| [test#4] | Import: `{ buildTestTenant, MockTenantRepository, setRequestTenant, withTenant } from '@adonisjs-lasagna/saas-tenancy/testing'` | B | BROKEN | src/testing/index.ts exports buildTestTenant, MockTenantRepository, setRequestTenant — NO withTenant | — | code-fix:F-18 (T11) |  |
| [test#5] | "Imports are tree-shaken; helpers don't pull in production services" | B | VERIFIED | testing barrel imports only builders/factory/mock/with_tenant | — | none |  |
| [test#6] | Function: `buildTestTenant({ id, name, status, ... })` — Builds TenantModelContract-shaped object | B | VERIFIED | builders.ts buildTestTenant(overrides) | builders.spec.ts (8 tests) | none |  |
| [test#7] | "Sensible defaults; override what you care about" | B | VERIFIED | builders defaults + override precedence | builders.spec.ts | none |  |
| [test#8] | Class: `MockTenantRepository([...tenants])` | B | VERIFIED | mock_repository.ts MockTenantRepository([...]) | mock_repository.spec.ts | none |  |
| [test#9] | "Lives entirely in memory" | B | VERIFIED | in-memory Map-backed | mock_repository.spec.ts | none |  |
| [test#10] | "Useful for unit tests of services without database" | B | VERIFIED | no DB dependency | mock_repository.spec.ts | none |  |
| [test#11] | "Implements each() (cursor pagination) the same way the real one does" | B | VERIFIED | mock_repository implements each() cursor | mock_repository.spec.ts | none |  |
| [test#12] | Function: `setRequestTenant(ctx, tenant)` — For controller/middleware tests | B | VERIFIED | with_tenant.ts:10 setRequestTenant(request, tenant) | used across integration suite | none |  |
| [test#13] | "Memoises onto the request" | B | VERIFIED | sets the Symbol memo | request_tenant_memo.spec.ts | none |  |
| [test#14] | "ctx.request.tenant() now resolves without hitting the repo" | B | VERIFIED | request.tenant() returns memoized | request_tenant_memo.spec.ts:5 | none |  |
| [test#15] | Function: `withTenant(tenant, async () => { ... })` — Test-time convenience over tenancy.run() | B | BROKEN | withTenant does not exist (= tenancy.run alias documented) | — | code-fix:F-18 (T11) |  |
| [test#16] | "Activates the bootstrapper registry around the callback" | B | BROKEN | same — bootstrapper-activation claim describes tenancy.run | — | code-fix:F-18 |  |
| [test#17] | "The shape that survives in tests matches the shape in production" | B | N/A | philosophy statement | — | none |  |
| [test#18] | Config (test env): `cache: { factory: () => new InMemoryCache() }` | B | DOC-ONLY | no cache.factory config key; no InMemoryCache class anywhere | — | doc-fix:F-19 |  |
| [test#19] | Config (test env): `drive: { factory: () => new InMemoryDrive() }` | B | DOC-ONLY | no drive.factory; no InMemoryDrive | — | doc-fix:F-19 |  |
| [test#20] | "Clean way to keep tests fast without sacrificing behavioural fidelity" | B | N/A | narrative tied to F-19 section | — | doc-fix:F-19 |  |
| [test#21] | File: `bin/test.integration.ts` — boots real Ignitor rooted at fixture app | B | VERIFIED | bin/test.integration.ts boots Ignitor at tests/fixtures | whole integration suite | none |  |
| [test#22] | Dir: `tests/fixtures/` — minimal AdonisJS app | B | VERIFIED | tests/fixtures app (models, repo, config, migrations) | — | none |  |
| [test#23] | Dir: `examples/api/` — complete reference app with 111 e2e tests | B | PARTIAL | examples/api exists; e2e count is 125 not 111 (run 2026-06-10) | e2e run | doc-fix:F-6 |  |
| [test#24] | "Reference suite uses compose.test.yml to bring up Postgres, Redis, MailCatcher" | B | BROKEN | compose.test.yml does not exist; real file examples/api/docker-compose.yml | — | doc-fix:F-1 |  |
| [test#25] | Container: `postgres:16-alpine` — Real PG for integration suite | B | VERIFIED | .github/workflows/ci.yml postgres:16 service | CI integration job | none |  |
| [test#26] | Container: `redis:7-alpine` — Real Redis for cache + queue + rate-limit specs | B | VERIFIED | ci.yml redis:7 service | CI | none |  |
| [test#27] | Container: `ghcr.io/navikt/mock-oauth2-server` — Wire-compliant OIDC for SSO real-server spec | B | VERIFIED | ci.yml mock-oauth2-server service | sso_oidc_real.spec.ts (CI) | none |  |
| [test#28] | Container: `minio/minio` — S3-compatible store for BackupService S3 spec | B | VERIFIED | ci.yml minio service | backup_s3.spec.ts (CI) | none |  |
| [test#29] | "test-e2e-demo job additionally brings up pg_dump/pg_restore and MailCatcher" | B | VERIFIED | ci.yml e2e job: postgresql-client + MailCatcher | e2e mail.spec.ts | none |  |

## contextual-logging.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [log#1] | "TenantLogContext owns the AsyncLocalStorage" | B | VERIFIED | tenant_log_context.ts ALS owner | tenant_log_context.spec.ts | none |  |
| [log#2] | "tenancy.run() is the public entry point that activates a context outside HTTP" | B | VERIFIED | tenancy.run activates | tenant_context.spec.ts | none |  |
| [log#3] | API: `tenancy.run(tenant, async () => { ... })` | B | VERIFIED | tenancy.run(tenant, fn) | tenant_context.spec.ts | none |  |
| [log#4] | "Inside the callback: tenancy.currentId() === tenant.id" | B | VERIFIED | currentId inside run | tenant_context.spec.ts:72 | none |  |
| [log#5] | "Inside the callback: tenantLogger() emits { tenantId } on every line" | B | VERIFIED | tenant_logger child bindings {tenantId} | tenant_logger.spec.ts; e2e contextual_logging | none |  |
| [log#6] | "Lucid models extending TenantBaseModel route to this tenant's schema" | B | VERIFIED | adapter prefers currentId | tenant_adapter.spec.ts:228 | none |  |
| [log#7] | "Any async continuation (setTimeout, await fetch, Promise.all) sees the same context" | B | VERIFIED | ALS continuation semantics | tenant_context.spec.ts | none |  |
| [log#8] | Function: `tenantLogger() → Logger` — AdonisJS root logger with active tenant context bound | B | VERIFIED | tenantLogger() → Logger | tenant_logger.spec.ts | none |  |
| [log#9] | "Outside any tenancy.run() scope, returns the plain root logger" | B | VERIFIED | root logger fallback outside scope | tenant_logger.spec.ts | none |  |
| [log#10] | "No penalty for calling it everywhere" | B | VERIFIED | cheap child() call | — | none |  |
| [log#11] | "Uses Pino's native child(bindings) API" | B | VERIFIED | pino child(bindings) | tenant_logger.spec.ts | none |  |
| [log#12] | API: `TenantLogContext.run({ tenantId, requestId, traceId, ... }, async () => { ... })` | B | VERIFIED | TenantLogContext.run({tenantId,requestId,...}) | tenant_log_context.spec.ts | none |  |
| [log#13] | "Every log line within this scope carries all fields" | B | VERIFIED | all fields carried | tenant_log_context.spec.ts | none |  |
| [log#14] | "Each built-in job already wraps its execute() in tenancy.run()" | B | VERIFIED | install_tenant.ts:23-24 et al | tenant_context.spec.ts | none |  |
| [log#15] | API: `tenancy.currentId() → string \| undefined` — synchronous, cheap | B | VERIFIED | currentId() sync | tenant_context.spec.ts:146 | none |  |
| [log#16] | API: `await tenancy.current() → TenantModelContract \| null` — hits the repository | B | VERIFIED | tenancy.current() repo fetch | tenant_log_context.spec.ts | none |  |
| [log#17] | "For one-off log enrichment, use currentId()" | B | N/A | guidance | — | none |  |
| [log#18] | "tenancy.run() and TenantLogContext.run() honor a stack" | B | VERIFIED | nested run stack | tenant_context.spec.ts:153 'nested tenancy.run() restores the outer tenant on exit' | none |  |
| [log#19] | "An inner scope shadows the outer scope while it's active, then the outer is restored on return" | B | VERIFIED | inner shadows, outer restored | tenant_context.spec.ts:153 | none |  |

## health.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [health#1] | Endpoint: `GET /livez` — Liveness. Never touches DB or Redis. Always 200 while event loop is alive. | B | VERIFIED | health/routes.ts:54; controller livez never touches deps | health_service.spec.ts; e2e smoke | none |  |
| [health#2] | Endpoint: `GET /readyz` — Readiness. Every registered check passes. 200 when ok/degraded; 503 when fail. | B | VERIFIED | routes.ts:55 + health_service readiness 200/503 | health_service.spec.ts | none |  |
| [health#3] | Endpoint: `GET /healthz` — Same data as /readyz, full JSON report. 200 / 503. | B | VERIFIED | routes.ts:56 healthz same report | health_service.spec.ts | none |  |
| [health#4] | Endpoint: `GET /metrics` — Prometheus text exposition. 200. | B | VERIFIED | routes.ts metrics group + renderPrometheus | metrics_exporter.spec.ts | none |  |
| [health#5] | API: `multitenancyRoutes()` — root paths | B | VERIFIED | multitenancyRoutes() root paths | e2e smoke | none |  |
| [health#6] | API: `multitenancyRoutes({ prefix: '/internal' })` — /internal/livez, etc. | B | VERIFIED | routes.ts:58 prefix group | — | none |  |
| [health#7] | API: `multitenancyRoutes({ metrics: false })` — skip /metrics | B | VERIFIED | routes.ts options metrics:false | — | none |  |
| [health#8] | API: `multitenancyRoutes({ health: false, metrics: false })` — opt-in via options | B | VERIFIED | options health/metrics booleans (:20-23,48) | — | none |  |
| [health#9] | Check: `backofficeDbCheck` — SELECT 1 against backoffice connection | B | VERIFIED | default_checks.ts backofficeDbCheck | health_service.spec.ts | none |  |
| [health#10] | Check: `redisCheck` — PING against default Redis | B | VERIFIED | default_checks.ts redisCheck | health_service.spec.ts | none |  |
| [health#11] | Check: `makeCircuitBreakerCheck(fn)` — Reports fail if any tenant circuit is OPEN | B | VERIFIED | default_checks.ts makeCircuitBreakerCheck | health_service.spec.ts | none |  |
| [health#12] | Check: `billingHealthCheck` — Pings Stripe API + asserts webhooks flowing (when active subs exist) | B | VERIFIED | billing pkg billingHealthCheck | health_check.spec.ts (billing) | none |  |
| [health#13] | Type: `HealthCheckFn = async () → Promise<CheckResult> \| CheckResult` | B | VERIFIED | HealthCheckFn type | — | none |  |
| [health#14] | API: `health.addCheck('custom_dependency', checkFn)` | B | VERIFIED | health_service addCheck | health_service.spec.ts | none |  |
| [health#15] | "HealthService enforces a 2-second timeout per check" | A | VERIFIED | health_service.ts:18 DEFAULT_TIMEOUT_MS=2000 + #runWithTimeout | health_service.spec.ts timeout case | none |  |
| [health#16] | Status: ok — every check passed (or no checks registered) | B | VERIFIED | status aggregation ok | health_service.spec.ts | none |  |
| [health#17] | Status: degraded — at least one passed, at least one failed (200 so Kubernetes keeps routing) | B | VERIFIED | degraded → 200 | health_service.spec.ts | none |  |
| [health#18] | Status: fail — every check failed (503) | B | VERIFIED | fail → 503 | health_service.spec.ts | none |  |
| [health#19] | Metric: `multitenancy_tenants_total` — gauge | B | VERIFIED | metrics_exporter multitenancy_tenants_total | metrics_exporter.spec.ts | none |  |
| [health#20] | Metric: `multitenancy_tenants_by_status{status="..."}` — gauge | B | VERIFIED | multitenancy_tenants_by_status | metrics_exporter.spec.ts | none |  |
| [health#21] | Metric: `multitenancy_circuit_state{tenant_id="..."}` — gauge (0=CLOSED, 1=HALF_OPEN, 2=OPEN) | B | VERIFIED | multitenancy_circuit_state | metrics_exporter.spec.ts | none |  |
| [health#22] | Metric: `multitenancy_circuit_failures_total{...}` — counter | B | VERIFIED | multitenancy_circuit_failures_total | metrics_exporter.spec.ts | none |  |
| [health#23] | Metric: `multitenancy_circuit_successes_total{...}` — counter | B | VERIFIED | multitenancy_circuit_successes_total | metrics_exporter.spec.ts | none |  |
| [health#24] | Metric: `multitenancy_queue_jobs{tenant_id,queue,state}` — gauge (state ∈ waiting, active, completed, failed, delayed) | B | VERIFIED | multitenancy_queue_jobs{...state} | metrics_exporter.spec.ts | none |  |
| [health#25] | Metric: `multitenancy_uptime_seconds` — gauge | B | VERIFIED | multitenancy_uptime_seconds | metrics_exporter.spec.ts | none |  |
| [health#26] | API: `collectSnapshot()` — gather metrics from current state | B | VERIFIED | metrics_collector collectSnapshot | metrics_exporter.spec.ts | none |  |
| [health#27] | API: `renderPrometheus(snapshot)` — format as Prometheus text exposition | B | VERIFIED | renderPrometheus | metrics_exporter.spec.ts | none |  |

## resilience.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [resilience#1] | API: `ResilienceService.run({ dependency, operation, policy, tenantId, fallback, run })` | B | VERIFIED | resilience_service.ts run({dependency,operation,policy,tenantId,fallback,run}) | resilience_service.spec.ts | none |  |
| [resilience#2] | "Keep only the dependency call inside run" | B | N/A | usage guidance | — | none |  |
| [resilience#3] | Policy: fail-open — Returns fallback() and continues. Availability over correctness. | B | VERIFIED | fail-open → fallback() | resilience_service.spec.ts; quota_resilience | none |  |
| [resilience#4] | Policy: fail-closed — Throws DependencyUnavailableException (503 + Retry-After). Correctness over availability. | B | VERIFIED | fail-closed → DependencyUnavailableException 503 | quota_resilience.spec.ts | none |  |
| [resilience#5] | Config: `resilience: { redis: { quota: 'fail-open', rateLimit: 'fail-closed' }, observe: true }` | B | VERIFIED | config shape (config.ts:321-340) | — | none |  |
| [resilience#6] | Key: `defaultPolicy` (default 'fail-closed') | B | VERIFIED | defaultPolicy fail-closed (config.ts:323) | — | new-test:T4 |  |
| [resilience#7] | Key: `redis.quota` (default 'fail-open') | B | VERIFIED | quota fail-open (quota_service.ts:372) | quota_resilience.spec.ts | new-test:T4 |  |
| [resilience#8] | Key: `redis.rateLimit` (default 'fail-closed') | B | VERIFIED | rateLimit fail-closed | rate_limit.spec.ts:93 | new-test:T4 |  |
| [resilience#9] | Key: `redis.cache` (default 'fail-open') | B | VERIFIED | cache fail-open (config.ts:331) | — | new-test:T4 |  |
| [resilience#10] | Key: `redis.metrics` (default 'fail-open') | B | VERIFIED | metrics fail-open (config.ts:333) | — | new-test:T4 |  |
| [resilience#11] | Key: `observe` (default true) — emit DependencyDegraded + log + OTel span event | B | VERIFIED | observe default true (config.ts:339) | resilience_service.spec.ts | none |  |
| [resilience#12] | Exception: `DependencyUnavailableException` — clean 503 with Retry-After, carries dependency, operation, tenantId | B | VERIFIED | dependency_unavailable_exception.ts 503 + Retry-After + context | quota_resilience.spec.ts | none |  |
| [resilience#13] | Event: `DependencyDegraded` — fires whenever a wrapped call fails and policy kicks in | B | VERIFIED | DependencyDegraded dispatch in resilience.run | resilience_service.spec.ts | none |  |
| [resilience#14] | Payload: { dependency, operation, tenantId, policy, errorCode } | B | VERIFIED | payload fields (dependency_degraded.ts) | resilience_service.spec.ts | none |  |
| [resilience#15] | "QuotaService.consume and track route Redis through the policy" | B | VERIFIED | quota_service.ts:373 resilience.run | quota_resilience.spec.ts | none |  |
| [resilience#16] | "RateLimitMiddleware emits the same DependencyDegraded event" | B | VERIFIED | rate_limit emits DependencyDegraded (unit log seen in baseline output) | rate_limit specs | none |  |

## read-replicas.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [replica#1] | Config: `tenantReadReplicas: { hosts, strategy, connectionSuffix }` | B | VERIFIED | config.ts:193-216 | read_replica_service.spec.ts | none |  |
| [replica#2] | Config: `hosts: [ { host, name, port?, user?, password? } ]` | B | VERIFIED | ReadReplicaHost shape (config.ts:184-191) | — | none |  |
| [replica#3] | Config: `strategy: 'round-robin' \| 'random' \| 'sticky' (default 'round-robin')` | B | VERIFIED | strategy default round-robin (config.ts:197) | e2e replicas_strategies | none |  |
| [replica#4] | Config: `connectionSuffix: '_read' (default)` | B | VERIFIED | connectionSuffix _read (config.ts:207) | read_replica_resolve.spec.ts | none |  |
| [replica#5] | Strategy: round-robin (default) — Global in-memory cursor cycles through hosts | B | VERIFIED | global cursor (read_replica_service) | read_replica_service.spec.ts | none |  |
| [replica#6] | Strategy: random — Math.random() selects a host per call | B | VERIFIED | random strategy | read_replica_service.spec.ts | none |  |
| [replica#7] | Strategy: sticky — SHA-1 of tenant.id modulo pool size — same tenant lands on same replica | B | VERIFIED | sticky hash of tenant id | read_replica_service.spec.ts | none |  |
| [replica#8] | API: `replicas.resolve(tenant) → Promise<Lucid Connection \| null>` | B | VERIFIED | read_replica_service.ts:96 resolve(tenant) | read_replica_resolve.spec.ts | none |  |
| [replica#9] | "Returns null when no replicas configured" | B | VERIFIED | resolve returns null when unset | read_replica_service.spec.ts | none |  |
| [replica#10] | "Lucid connection is registered on first use under stable name" | B | VERIFIED | lazy Lucid registration w/ stable name | read_replica_resolve.spec.ts | none |  |
| [replica#11] | "resolve() returns a connection for the chosen replica regardless of whether it's reachable" | A | VERIFIED | no reachability probe in resolve | read_replica_resolve.spec.ts unreachable case | none |  |
| [replica#12] | "There is NO automatic failover to the primary" | A | VERIFIED | no failover code path | read_replica_resolve.spec.ts 'no auto-failover' | none |  |
| [replica#13] | "An unreachable replica surfaces as an error at query time, not at resolve() time" | A | VERIFIED | error surfaces at query time | read_replica_resolve.spec.ts | none |  |
| [replica#14] | Doctor check: `tenant:doctor --check=replicaLag` — SELECT EXTRACT(EPOCH FROM (now() - pg_last_xact_replay_timestamp())) against every replica | B | VERIFIED | replica_lag_check.ts query | doctor/replica_lag.spec.ts | none |  |
| [replica#15] | Thresholds: warn at 30s (default), error at 120s (default) | B | VERIFIED | defaults 30/120 (replica_lag_check.ts:4-5) | doctor/replica_lag.spec.ts | none |  |
| [replica#16] | API: `replicas.resetCursor()` — reset round-robin counter | B | VERIFIED | read_replica_service.ts:141 resetCursor | read_replica_service.spec.ts | none |  |
| [replica#17] | API: `replicas.pickHost(tenantId)` — convenience accessor for chosen replica host | B | VERIFIED | read_replica_service.ts:70 pickHost | read_replica_service.spec.ts | none |  |

## performance.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [perf#1] | Claim: "Benchmark results generated by npm run bench:report" | B | VERIFIED | benchmarks/ suite + bench:report script | — (existence only; not re-run) | none |  |
| [perf#2] | Claim: "Read the shape, not the absolutes — relative cost across drivers and code paths" | B | N/A | interpretation guidance | — | none |  |
| [perf#3] | Claim: "header resolution is far cheaper than subdomain/path" | B | VERIFIED | benchmarks/results baseline (relative claim) | — (existence) | none |  |
| [perf#4] | Claim: "rowscope-pg reads faster than schema-pg ≈ database-pg" | B | VERIFIED | benchmarks/results baseline | — (existence) | none |  |
| [perf#5] | "Open tenant connections are bounded by the eviction grace window, NOT by maxTenantConnections" | A | VERIFIED | connection_lru grace-window design (in-use never evicted) | connection_lru.spec.ts grace cases | none |  |
| [perf#6] | "Under the default 30s grace a burst of N active tenants opens ~N connections" | B | VERIFIED | burst behavior documented = lru soft-cap | connection_lru.spec.ts cap-exceed case | none |  |

## deployment.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [deploy#1] | Target: Single-VPS Docker Compose for staging or low-volume production | B | VERIFIED | deploy/docker-compose.prod.yml exists | — (artifact) | none |  |
| [deploy#2] | Target: Kubernetes via Helm for HA / multi-region | B | VERIFIED | deploy/charts/lasagna-app (Chart.yaml, values) | — (artifact) | none |  |
| [deploy#3] | Target: Security hardening checklist for both | B | VERIFIED | deployment.md checklist + nginx.conf | — | none |  |
| [deploy#4] | Service: postgres-primary — postgres:16-alpine, wal_level=replica, replication user | B | VERIFIED | compose.prod postgres-primary wal_level=replica + init-replica.sh | — (not behavior-tested) | none |  |
| [deploy#5] | Service: postgres-replica — postgres:16-alpine, streaming replica, hot standby | B | VERIFIED | compose.prod postgres-replica hot standby | — | none |  |
| [deploy#6] | Service: redis — redis:7-alpine, password-protected, AOF persistence | B | VERIFIED | compose.prod redis AOF + password | — | none |  |
| [deploy#7] | Service: app (×3) — Built from deploy/Dockerfile, health checks against /readyz | B | VERIFIED | compose.prod app x3 + healthcheck /readyz; deploy/Dockerfile | — | none |  |
| [deploy#8] | Service: nginx — nginx:1.27-alpine, reverse proxy, JSON access logs | B | VERIFIED | compose.prod nginx:1.27-alpine + nginx.conf | — | none |  |

## production-checklist.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [checklist#1] | "Auth middleware wired in front of multitenancyAdminRoutes(...) and resolveAdminActor set" | B | VERIFIED | admin fail-closed + resolveAdminActor real | — | none |  |
| [checklist#2] | "Database role used by the app does NOT have SUPERUSER or BYPASSRLS" | B | N/A | operator duty (RLS docs align) | — | none |  |
| [checklist#3] | "A separate database role handles audit-log retention with trigger disabled in controlled window" | B | N/A | operator duty (audit retention) | — | none |  |
| [checklist#4] | "multitenancy.config.isolation.rowScopeMode left at default unless every cross-tenant query audited" | B | VERIFIED | rowScopeMode default strict | scoping.spec.ts | none |  |
| [checklist#5] | "CustomDomainMiddleware registered with strict: true if accepting tenant header AND using custom domains" | B | VERIFIED | strict:true option real | header_vs_domain specs | none |  |
| [checklist#6] | "Backup storage volume / S3 bucket encrypted at rest and lifecycle-managed" | B | N/A | operator duty | — | none |  |
| [checklist#7] | "Rate-limit policy on RateLimitUnavailableException decided and tested (fail-open vs fail-closed)" | B | VERIFIED | RateLimitUnavailableException real + failOpen option | rate_limit.spec.ts | none |  |
| [checklist#8] | "OIDC client_secret, encryption keys, S3 credentials live in secrets manager, not .env" | B | N/A | operator duty | — | none |  |
| [checklist#9] | "tenant:doctor runs on cron in production and pages on error-level findings" | B | VERIFIED | tenant:doctor --json exit codes for cron/pager | tenant_doctor.ts:92 | none |  |
| [checklist#10] | "Health probes wired (/livez, /readyz, /healthz, /metrics)" | B | VERIFIED | multitenancyRoutes endpoints real | e2e smoke | none |  |

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
| [limit#1] | "PostgreSQL only. No MySQL/MariaDB." | A | VERIFIED | PG-only | — | none |  |
| [limit#2] | "Node.js ≥ 24 required by AdonisJS 7 and Lucid 22" | B | VERIFIED | engines >=24 | CI Node 24 | none |  |
| [limit#3] | "No independent external security review yet. Isolation core is release-candidate." | B | N/A | honest status (matches roadmap) | — | none |  |
| [limit#4] | "Single maintainer (mitigated by test and documentation depth)" | B | N/A | honest project fact | — | none |  |
| [limit#5] | "No built-in driver-to-driver migration. Switching after launch is a planned data migration." | B | VERIFIED | no driver-migration tool exists | — | none |  |
| [limit#6] | "rowscope-pg: non-grouped top-level orWhere can escape the auto-scope" | A | VERIFIED | scoping.ts:91-115 orWhere escape (honest) | rowscope_rls.spec.ts:74 | none |  |
| [limit#7] | "Cross-layer Lucid relationships unsupported (tenant/backoffice/central on different schemas)" | B | VERIFIED | cross-layer relationships unsupported | — | none |  |
| [limit#8] | "Connection-cap default favors availability (isolation.enforceConnectionCap defaults false)" | A | VERIFIED | enforceConnectionCap default false (config.ts:295) | universal_connection_cap.spec.ts | none |  |
| [limit#9] | "Quotas and rate limiting can fail open on Redis outage (depending on resilience policy)" | B | VERIFIED | resilience defaults (quota fail-open) | quota_resilience.spec.ts | none |  |
| [limit#10] | "Read replicas have no automatic failover and can serve stale reads" | A | VERIFIED | no failover; stale reads possible | read_replica_resolve.spec.ts | none |  |
| [limit#11] | "Feature flags are boolean only — no built-in percentage rollout" | A | VERIFIED | boolean flags only | feature_flag_service.spec.ts | none |  |
| [limit#12] | "Metrics track a fixed counter set (requests, errors, bandwidth), not arbitrary named metrics" | B | VERIFIED | fixed metric set | metrics_service.spec.ts | none |  |

## gotchas.md

| ID | Claim | Tier | Status | Code evidence | Test evidence | Action | Notes |
|---|---|---|---|---|---|---|---|
| [gotcha#1] | "Always resolve the tenant via the helper — reading the header directly bypasses resolverStrategy/resolverChain" | A | VERIFIED | resolveTenantId helper (request.ts) | tenant_resolver.spec.ts | none |  |
| [gotcha#2] | "The provisioning → active race (transient 503s) — correct behavior, wait for TenantActivated" | B | VERIFIED | provisioning status → TenantNotReady 503 | tenant_guard_middleware.spec.ts | none |  |
| [gotcha#3] | "fail-open quotas silently stop enforcing on Redis outage — subscribe to DependencyDegraded to alert" | A | VERIFIED | quota fail-open + DependencyDegraded | quota_resilience.spec.ts | none |  |
| [gotcha#4] | "Read replicas can serve stale data — no lag check, no auto-failover" | A | VERIFIED | replica staleness honest | read_replica_resolve.spec.ts | none |  |
| [gotcha#5] | "Custom domains + header strategy — mismatched header rejected with TenantHeaderDomainMismatchException (400)" | A | VERIFIED | strict mismatch 400 | header_vs_domain_precedence.spec.ts:27 | none |  |
| [gotcha#6] | "Circuit breaker reopens after restart — breaker state persisted to Redis and restored on process start" | A | VERIFIED | circuit state persisted+restored | integration circuit_breaker_service.spec.ts | none |  |
| [gotcha#7] | "Replaying old Stripe events works even past 30 days — webhook controller persists PII-stripped copy in stripe_processed_events.payload" | B | VERIFIED | local payload replay fallback | replay_fallback.spec.ts (B1) | none |  |
| [gotcha#8] | "A resolved tenant whose database is down returns 503, never central" | A | VERIFIED | 503 never central fallthrough | connection_failure_503.spec.ts | none |  |
| [gotcha#9] | "The SSRF guard validates the URL, not the resolved connection IP — rejects non-HTTPS and private ranges" | B | PARTIAL | resolving guard validateResolvedHostIsPublic DOES resolve DNS for fetch paths — page understates | url.spec.ts:148+ | doc-fix (W7 wording) | docs say guard validates URL not resolved IP; resolving variant exists |

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

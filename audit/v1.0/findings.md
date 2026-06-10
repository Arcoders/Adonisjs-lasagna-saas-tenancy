# v1.0 Audit — Findings

Numbered findings from the documentation-truthfulness audit. Each links the matrix claim
IDs it affects. Severity: **HIGH** = a user relying on the claim could be harmed;
**MED** = misleading; **LOW** = imprecise.

Resolution legend: `code-fix` (behavior brought up to the documented intent, with a
regression test), `doc-fix` (claim rewritten to match deliberate behavior), `test-fix`
(test strengthened to actually prove the claim).

---

## F-1: docs reference a `compose.test.yml` that does not exist

- **Claims:** [contrib#2], [showcase#3], [test#24]
- **Severity:** MED (copy-pasting the documented command fails immediately)
- **Doc text:** `docker compose -f compose.test.yml up -d` (contributing.md, showcase.md, testing.md)
- **Reality:** no `compose.test.yml` / `compose*.yml` anywhere in the repo. The infra file is
  `examples/api/docker-compose.yml` (default name; `docker compose up -d` from `examples/api`,
  or `npm run infra:up`). Verified by glob over the whole tree on 2026-06-10.
- **Resolution:** doc-fix — point all three pages at the real file/commands. (A code-fix
  alternative — adding a root-level `compose.test.yml` — would duplicate infra definitions;
  the example-app compose is the canonical one.)
- **Status:** open

## F-2: quota concurrency spec is weaker than the documented guarantee

- **Claims:** [why#4], [security#6], [security#17]
- **Severity:** MED (the guarantee is documented as exact; the test tolerates under-grant and
  still carries the pre-Lua "near-atomic" caveat in its header)
- **Doc text:** "50 parallel callers against limit=10 produce exactly ten successes and forty
  QuotaExceededException. No race window." (why.md)
- **Reality:** `QuotaService.consume()` is single-EVAL Lua (atomic). The spec
  `packages/core/tests/integration/services/quota_concurrency.spec.ts` asserts only
  `isAtMost(fulfilled, limit)` / `isAtLeast(quotaExceeded, parallelism - limit)` and its
  comment block still describes the outdated "near-atomic" caveat.
- **Resolution:** test-fix (T0) — tighten to exact equality, delete the stale comments.
  Plus doc-fix: one-sentence qualifier that enforcement requires Redis (consume() is
  fail-open on Redis outage by default per `resilience.redis.quota`).
- **Status:** open

## F-3: security.md describes the rate-limit failure policy incorrectly

- **Claims:** [security#13] vs [why#8]
- **Severity:** MED (two pages disagree; the security page's status-code framing is wrong)
- **Doc text:** "The host decides whether that maps to fail-open (502) or fail-closed (429)"
  (security.md:48)
- **Reality:** `RateLimitMiddleware` defaults `failOpen: false` and throws
  `RateLimitUnavailableException` on Redis outage (5xx, not 429); `failOpen: true` lets the
  request proceed (no status at all). why.md's "Redis down means 503, never silent
  fail-open; opt into failOpen: true" matches the code.
- **Resolution:** doc-fix — rewrite security.md:48 to match why.md and the actual exception
  semantics. Verify the exception's HTTP status in the spec while editing.
- **Status:** open

## F-4: `backoffice:setup` discards the underlying migration error

- **Claims:** [quickstart#3] ("Idempotent; re-run any time" — when it *does* fail, the
  operator gets no diagnostic)
- **Severity:** MED (operational diagnosability; hit in practice during this audit's
  baseline: the only output was "Backoffice migration failed" while the real error was
  `relation "tenants" already exists`)
- **Reality:** `packages/core/src/commands/setup_backoffice.ts:32-35` checks
  `migrator.status === 'error'` and logs a generic line; `migrator.error` (the actual
  failure) is never surfaced. Running `migration:run --connection=backoffice` by hand was
  required to see the cause.
- **Resolution:** code-fix — log the migration file name + underlying error message when
  the runner reports `error`. Consider a hint pointing at the per-file statuses
  (`migrator.migratedFiles`).
- **Status:** open

## F-5: security.md's seven "failure modes" GitHub links 404 after the monorepo restructure

- **Claims:** [security#14..20]
- **Severity:** LOW (the specs exist and match their descriptions; only the URLs are stale)
- **Doc text:** links point at `blob/master/tests/integration/...`
- **Reality:** the specs live at `packages/core/tests/integration/...` since the core moved
  into `packages/core` for Changesets.
- **Resolution:** doc-fix — update the seven URLs (and any other `blob/master/tests/` or
  `blob/master/src/` links across the docs site) to the `packages/core/` paths.
- **Status:** open

## F-6: "111-test e2e suite" count has drifted

- **Claims:** [showcase#2], [test#23]
- **Severity:** LOW (undersells; exact counts rot)
- **Reality:** the example-app e2e suite is 125 tests as of 2026-06-10 (full local run:
  125 passed).
- **Resolution:** doc-fix — update or de-precision the number in showcase.md and
  testing.md.
- **Status:** open

## F-7: bulk-write scoping mechanism is mis-described (doc + stale test titles), and bulk UPDATE lacks a real-Lucid test

- **Claims:** [security#4]
- **Severity:** MED for the coverage gap, LOW for the wording
- **Doc text:** "Bulk `Model.query().delete()` / `.update()` … are intercepted by the
  `before('fetch')` hook (Lucid fires it for query-builder paths)." (security.md)
- **Reality:** the source says the opposite and guards differently:
  `packages/core/src/models/scoping.ts:149-166` — "Lucid's `before:fetch` only fires when
  knex's `_method === 'select'`, so query-builder DELETE/UPDATE wouldn't get scoped through
  it" — and wraps the static `query()` factory to inject the predicate at construction
  time. The *outcome* (bulk delete is tenant-scoped) IS proven against real Lucid + PG:
  `packages/core/tests/integration/services/rowscope_pg_driver.spec.ts:238` ("bulk delete
  via query builder is scoped"). But (a) that test's title and the unit group in
  `tests/unit/models/scoping.spec.ts:263` repeat the wrong mechanism ("Lucid fires
  before:fetch") — the unit test manually invokes the hook on a fake model, proving
  nothing about Lucid; (b) bulk `.update()` has no real-Lucid test at all.
- **Resolution:** code-fix scope: add a real-Lucid bulk-UPDATE isolation test next to the
  bulk-delete one; fix the stale test titles/comments. doc-fix: security.md describes the
  construction-time `query()` predicate as the mechanism.
- **Status:** open

## F-8: security.md's "bounded connection pool" row predates the in-core LRU

- **Claims:** [security#10]
- **Severity:** MED (tells hosts to hand-roll a safeguard the package now owns; understates
  the actual guarantee)
- **Doc text:** "The fixture `Tenant` model demonstrates an LRU cap on tenant connections
  (50 by default)… Hosts should keep this LRU pattern in their `Tenant` implementation."
- **Reality:** since the Carril-A hardening, the LRU is implemented in the package:
  `packages/core/src/services/isolation/connection_lru.ts` (DEFAULT_MAX_TENANT_CONNECTIONS
  = 50) and is wired into `schema_pg_driver.ts:45` / `database_pg_driver.ts:52` with a
  grace window and optional hard cap (`isolation.enforceConnectionCap`). Hosts configure
  it; they do not implement it. Tested: `tests/unit/services/connection_lru.spec.ts` (17
  tests), `tests/integration/middleware/universal_connection_cap.spec.ts`.
- **Resolution:** doc-fix — rewrite the row to describe the in-core LRU + config knobs.
- **Status:** open

## F-9: admin fail-closed startup throw has no test

- **Claims:** [security#12], [upgrade#7], [auth#…]
- **Severity:** MED (a documented security default with zero enforcement)
- **Reality:** `packages/admin/src/routes.ts:130-140` implements the throw; no spec in
  `packages/admin/tests` or e2e covers the omitted-middleware or `middleware: false`
  branches.
- **Resolution:** code-fix scope — new unit spec (T9) in packages/admin asserting: omitted
  middleware throws with the documented message; `middleware: false` mounts public;
  middleware provided guards the group.
- **Status:** open

## F-10: bootstrapper count is inconsistent across pages (and "queue" is not a bootstrapper)

- **Claims:** [why#1] ("6 bootstrappers"), why.md:47 card ("Cache, drive, mail, session,
  queue, transmit"), [intro#2] ("Five bootstrappers: cache, drive, mail, session,
  broadcasting"), [showcase#1] ("all six bootstrappers")
- **Severity:** MED (three pages, three different stories)
- **Reality:** the BootstrapperRegistry registers exactly 5: cache (always) + drive, mail,
  session, transmit when their bindings exist (`multitenancy_provider.ts:147-264`). Queue
  tenant-scoping exists but flows through `tenancy.run()` in job execution, not a
  bootstrapper. intro.md matches the code; why.md and showcase.md overcount.
- **Resolution:** doc-fix — align on "five bootstrappers (cache, drive/filesystem, mail,
  session, broadcasting/transmit)" and describe queue scoping separately, which is also
  more accurate about the mechanism. Check docs/bootstrappers/index.md taxonomy (it has a
  database.md page) in W3 before wording the fix.
- **Status:** open

## F-11: "ten built-in checks" counts a check that ships in another package

- **Claims:** [why#…] (doctor card: "ten built-in checks"), [intro#4] ("tenant:doctor (ten
  checks, --fix, --watch, --json)")
- **Severity:** LOW/MED (core-only installs get 9; the 10th, `backup_recency`, registers
  only when `@adonisjs-lasagna/backup`'s provider is installed — upgrade-to-1.0.md states
  this correctly)
- **Reality:** `packages/core/src/services/doctor/checks/` holds 9 checks
  (circuit_breaker, connection_pool, failed_tenants, long_running_queries,
  migration_state, provisioning_stalled, queue_stuck, replica_lag, schema_drift);
  `packages/backup/src/doctor/backup_recency_check.ts` is the 10th.
- **Resolution:** doc-fix — "nine built-in checks (plus `backup_recency` when the backup
  satellite is installed)".
- **Status:** open

## F-12: configuration.md claims to be exhaustive but misses 12 config keys

- **Claims:** [config#…] (page title/intro: "Every config/multitenancy.ts option … this
  page is the exhaustive reference")
- **Severity:** MED (operators tuning the connection budget won't find the knobs)
- **Missing keys (present in `src/types/config.ts`):** `resolver.legacyAdapterFallback`;
  `isolation.maxTenantConnections` (50), `isolation.evictionGracePeriodMs` (30000),
  `isolation.enforceConnectionCap` (false); `routing.autoLoad` (true),
  `routing.tenantRoutesFile`, `routing.universalRoutesFile`;
  `maintenanceSchedule.backupHour`, `maintenanceSchedule.migrateAllHour`;
  `onboarding.wizardTtl`, `onboarding.wizardKeyPrefix`; `hooks`;
  `tenantReadReplicas.maxReplicaConnections` (50).
- **Everything the page DOES document matches the code** (every type and default
  cross-checked against config.ts on 2026-06-10).
- **Resolution:** doc-fix — add the missing rows (grouped sensibly) or link where they are
  documented; keep the "exhaustive" promise true.
- **Status:** open

## F-13: commands.md lists backup-package commands without the install caveat

- **Claims:** [cmd#…] (Operations table: tenant:backup, tenant:backups:run,
  tenant:backup:list, tenant:restore, tenant:import, tenant:clone)
- **Severity:** MED (a core-only install doesn't have these; the Billing section right
  below does carry the equivalent caveat)
- **Reality:** all six commands exist with exactly the documented flags — in
  `packages/backup/src/commands/commands.json`. They register only when
  `@adonisjs-lasagna/backup`'s provider+commands are wired (per upgrade-to-1.0.md).
- **Resolution:** doc-fix — add an "available when @adonisjs-lasagna/backup is installed"
  note mirroring the Billing section's.
- **Status:** open

## F-14: doctor check names drift in two docs

- **Claims:** commands.md doctor example, why.md doctor bullet
- **Severity:** LOW/MED (copy-pasted commands target a nonexistent check)
- **Reality:** registered check names are `schema_drift`, `migration_state`,
  `circuit_breakers`, `connection_pool`, `queue_health`, `failed_tenants`,
  `provisioning_stalled`, `long_running_queries`, `replica_lag` (+ `backup_recency` from
  the backup pkg). commands.md's example uses `--check=schema_drift,backups` ("backups" is
  not a check); why.md says "`queue_stuck` runs in CI" (the *spec file* is
  queue_stuck.spec.ts but the check is `queue_health`).
- **Resolution:** doc-fix — correct both names.
- **Status:** open

## F-15: exceptions.md says "Every exception" but omits three; one isn't even exported

- **Claims:** [exc#…] (page description: "Every exception the package can throw")
- **Severity:** MED
- **Reality:** the 13 documented exceptions match code exactly (status + code
  cross-checked). Missing from the page: `ImpersonationInvalidException` (401,
  E_IMPERSONATION_TOKEN_INVALID), `IsolationConfigException` (500, E_ISOLATION_CONFIG),
  `TenantConnectionLimitException` (503, E_TENANT_CONNECTION_LIMIT). The last one is
  thrown by both PG drivers when `isolation.enforceConnectionCap` is on but is **not
  exported from `src/exceptions/index.ts`**, so hosts cannot catch it by type.
- **Resolution:** code-fix — export `TenantConnectionLimitException` from the barrel.
  doc-fix — add the three missing rows to exceptions.md.
- **Status:** open

## F-16: schema-pg.md claims session termination the schema driver doesn't do

- **Claims:** [schema#8]
- **Severity:** MED (an operator counting on the purge not hanging behind an active
  session will be surprised)
- **Doc text:** "`tenant:purge-expired` calls `driver.destroy()`: `pg_terminate_backend`
  against any sessions on the schema. `DROP SCHEMA … CASCADE`." (schema-pg.md:32-35)
- **Reality:** `schema_pg_driver.ts:81` destroy is `DROP SCHEMA IF EXISTS … CASCADE`
  only. `pg_terminate_backend` exists solely in `database_pg_driver.ts:99` (where it is
  meaningful — PG sessions attach to a *database*, not a schema; "sessions on the schema"
  is not a PG concept). An in-flight query holding locks on the tenant's tables will make
  the DROP wait, not fail.
- **Resolution:** doc-fix — remove the pg_terminate_backend step from the schema-pg
  teardown list and add one sentence about lock-waiting semantics. (Not a code-fix:
  per-schema session targeting is not cleanly implementable; the database-pg page is
  already correct.)
- **Status:** open

## F-17: jobs.md import snippet doesn't compile — six of "all eight" jobs moved out of core in 1.0

- **Claims:** [job#3..8], [job#14], [job#16..19]
- **Severity:** HIGH (primary how-to page; the documented import fails at typecheck for
  anyone following it; jobs.md never caught up with the 1.0 satellite extraction)
- **Doc text:** "All eight are exported from `@adonisjs-lasagna/saas-tenancy/jobs`" +
  snippet importing InstallTenant, UninstallTenant, BackupTenant, RestoreTenant,
  CloneTenant, ProcessStripeEventJob, ReportUsageBatchJob, BillingCleanupJob from the
  core subpath (jobs.md:28-40), plus dispatch examples for the moved jobs.
- **Reality:** `packages/core/src/jobs/index.ts` exports only InstallTenant +
  UninstallTenant and explicitly notes the rest moved to `@adonisjs-lasagna/backup` /
  `@adonisjs-lasagna/billing`. upgrade-to-1.0.md documents the move correctly.
- **Resolution:** doc-fix — restructure jobs.md: core jobs from core, backup jobs from
  @adonisjs-lasagna/backup, billing jobs from @adonisjs-lasagna/billing (re-exporting in
  core would recreate the coupling 1.0 removed, so not a code-fix).
- **Status:** open

## F-18: `withTenant` testing helper is documented but does not exist

- **Claims:** [test#4], [test#15], [test#16], [faq#10]
- **Severity:** HIGH (documented import fails; two pages advertise it)
- **Doc text:** testing.md documents `withTenant(tenant, async () => { … })` as a
  "test-time convenience over tenancy.run()" that "activates the bootstrapper registry
  around the callback"; faq.md lists it among shipped helpers.
- **Reality:** no `withTenant` symbol exists anywhere in `packages/core/src`. The file
  `src/testing/with_tenant.ts` only exports `setRequestTenant`. The documented behavior is
  exactly `tenancy.run(tenant, fn)`.
- **Resolution:** code-fix (T11) — implement `withTenant` in `src/testing/with_tenant.ts`
  as the documented thin wrapper over `tenancy.run`, export it from the /testing barrel,
  and add a unit spec. The doc described clear intent; the alias is one line and keeps
  both pages true.
- **Status:** open

## F-19: "Hermetic bootstrapper factories" section documents a nonexistent feature

- **Claims:** [test#18], [test#19]
- **Severity:** HIGH (the snippet `cache: { factory: () => new InMemoryCache() }` neither
  typechecks — `MultitenancyConfig.cache` has only `ttl` + `redis` — nor do
  `InMemoryCache`/`InMemoryDrive` classes exist anywhere in the package)
- **Reality:** the supported way to swap a bootstrapper in tests is the registry: the
  provider only registers built-ins when absent (`multitenancy_provider.ts:147`
  `if (!bootstrappers.has('cache'))`), so a test can `register()` its own named
  bootstrapper first. There is no factory config surface.
- **Resolution:** doc-fix — delete the factory snippet and rewrite the section around
  `BootstrapperRegistry.register()` (pre-registration wins) + the sqlite-memory driver.
  (Adding a factory config would be a new feature, out of audit scope — flagged for the
  maintainer's roadmap if wanted.)
- **Status:** open

## F-20: Redis version floor understated for SSO

- **Claims:** [install#4]
- **Severity:** LOW
- **Reality:** installation.md says "Redis ≥ 6"; `SsoService.handleCallback` uses `GETDEL`
  which requires Redis ≥ 6.2 (`packages/sso/src/sso_service.ts:88` documents this).
- **Resolution:** doc-fix — "Redis ≥ 6 (≥ 6.2 when using the SSO satellite)".
- **Status:** open

## F-21: bootstrappers/index.md documents a phantom `priority` and wrong type names

- **Claims:** [bootstrap#14], [bootstrap#16] (+ the custom-bootstrapper example)
- **Severity:** MED/HIGH (the example doesn't typecheck: imports `Bootstrapper` and
  `TenantContext` from /services — the barrel exports `TenantBootstrapper` and
  `BootstrapperContext` (`services/index.ts:35`); and the interface has no `priority`
  field)
- **Reality:** ordering is **registration order** (enter ascending, leave LIFO) —
  `bootstrapper_registry.ts`; spec: "runEnter executes in registration order, runLeave in
  reverse". The provider registers cache, drive, mail, session, transmit in that order,
  which produces the documented default ordering — but there is no numeric priority.
- **Resolution:** doc-fix — rewrite "Order matters" around registration order and fix the
  example to `implements TenantBootstrapper` with `BootstrapperContext`. (Adding a
  priority field would be a new feature.)
- **Status:** open

## F-22: the four service-bootstrapper pages describe transparent interception + config blocks that don't exist

- **Claims:** [fs-bootstrap#2..#7], [mail-bootstrap#2..#5], [session-bootstrap#2,#3,#5,#7],
  [broadcast-bootstrap#2,#6] (+ index's [bootstrap#4] prefix shape)
- **Severity:** HIGH (systemic: every per-service page documents a design that was not
  built; several snippets neither typecheck nor have any runtime effect)
- **Doc claims vs reality:**
  - filesystem.md: "prefixes every filesystem operation"; `drive.list()` returns
    tenant-relative paths; `{ raw: true }` escape; config `drive: { enabled, prefix }`.
    Reality: explicit `tenantDisk()` proxy prefixes keys on listed methods with the
    constant `tenants/<id>/` (drive_bootstrapper.ts:26,111); plain `drive.use()` is
    untouched; list results are NOT relativized; no `raw` option; no config block.
  - mail.md: "mail.send() resolves SMTP credentials and from address from the tenant's
    branding record"; config `mail: { enabled, resolver }`. Reality: per-tenant transport
    selection is explicitly a host-app concern (mail_bootstrapper.ts:26-29);
    `tenantMailer(transportName?)` stamps an `X-Tenant-Id` header — that's all.
  - session.md: "prefixes every session read and write"; config
    `session: { enabled, prefix: 't:{id}:' }`; disable via `bootstrappers: { session:
    false }`. Reality: explicit `tenantSession(ctx)` / `tenantSessionKey(key)` helpers
    with constant `tenants/<id>/`; none of those config keys exist; opt-out is
    `registry.unregister('session')`.
  - broadcasting.md: "every transmit.broadcast()/subscribe() silently rewritten"; config
    `transmit: { enabled, prefix }`. Reality: explicit `tenantBroadcast()` /
    `tenantChannel()` helpers; prefix configurable only programmatically via
    `createTransmitBootstrapper({ prefix })` (transmit_bootstrapper.ts:26-45).
  - index.md says cache namespace is `tenants/<id>/…`; real shape is `tenant:<id>`
    (cache.ts:65). cache.md itself is accurate (helper-based, `cacheFor`).
- **Resolution:** doc-fix — rewrite the four pages around the real helper APIs
  (tenantDisk/tenantMailer/tenantSession+tenantSessionKey/tenantBroadcast+tenantChannel),
  drop the phantom config blocks, fix the index prefix shape. Implementing transparent
  interception would be a major feature, out of audit scope — listed for the roadmap.
- **Status:** open

## F-23: webhooks.md — wrong API names, fictional auto-generated secret, wrong state names

- **Claims:** [webhook#2], [webhook#3], [webhook#4], [webhook#13..15]
- **Severity:** HIGH for the secret claim (users assuming auto-signing ship UNSIGNED
  webhooks); MED for the rest
- **Reality vs doc:**
  - API: doc `webhooks.subscribe({ tenantId, events, url, secret? })` / `dispatch({...})`
    object-style — code is positional `registerWebhook(tenantId, url, events, secret?)`
    (webhook_service.ts:174) and `dispatch(tenantId, event, payload)`. No `subscribe`
    exists; doc snippet doesn't compile.
  - Secret: doc "Generated when omitted; encrypted at rest with APP_KEY (AES-256-GCM)" —
    code `secret ? encrypt(secret) : null` (:186): nothing is generated; a null secret
    means `x-webhook-signature` is simply not sent (:131 is conditional). Encryption at
    rest of *provided* secrets is real (crypto.ts).
  - Delivery states: doc `pending → delivering → delivered/failed →
    retry_scheduled/permanently_failed` — code states are `pending`, `success`,
    `failed`, `retrying` (:88,:143,:146,:153).
  - Headers (4), backoff schedule + ±20% jitter, constant-time verify: all VERIFIED.
- **Resolution:** decision for the maintainer baked into W7: either code-fix the secret
  generation (generate a random secret when omitted — matches documented intent and is
  safer-by-default; small change + test) or doc-fix to "unsigned when omitted". Given
  "fix everything found" and that unsigned-by-silent-default is a footgun, plan is
  code-fix (T12) + doc-fix for names/states.
- **Status:** open

## F-24: impersonation.md describes a one-shot-grant design that was never built (plus wrong defaults and API)

- **Claims:** [impersonate#4], [impersonate#7], [impersonate#9], [impersonate#11..15],
  [impersonate#19]
- **Severity:** HIGH (security semantics: the page promises single-use tokens; real
  tokens are valid for the whole session TTL — a captured token IS replayable until
  expiry/stop; also the page contradicts itself on the default duration)
- **Reality vs doc:**
  - Default duration: page intro says "default 1 hour", its own config block says
    "default 900 (15 min)" — code default is 3600 (config.ts:390).
  - API: doc `impersonation.issue({...}) → { token, redirectUrl }` — code
    `start(opts) → { token, sessionId, expiresAt }` (impersonation_service.ts:46,107);
    `redirectUrl` is assembled by the ace command only. Snippet doesn't compile.
  - Token sources: doc "imp query param or header" — code reads header
    (`x-impersonation-token`) or cookie (`__impersonation`); NO query param
    (impersonation_middleware.ts:31-33). Code is right (query tokens leak into logs).
  - Single-use/GETDEL: doc claims consume-on-read three times — code sessions persist in
    cache with TTL; verify() does not consume; stop()/revokeById() revoke explicitly.
  - Audit actions: doc `impersonation.granted/consumed/expired` — code
    `admin:impersonate:start` (+ companion actions in stop/verify paths).
  - TRUE and verified: HMAC-SHA256 over random session id (:70,:108), timingSafeEqual
    (:220), ≥32-char secret validated at provider boot
    (multitenancy_provider.ts:150,230) AND at use (:226), clamp [60, maxDuration] (:68),
    tenant binding (middleware:52-63, integration spec).
- **Resolution:** doc-fix — rewrite the page around the real session model (time-boxed,
  revocable, tenant-bound; NOT single-use), real API names, real defaults, real audit
  actions. Making tokens literally single-use would break the documented "session"
  workflow (every page navigation would need a new token) — the doc's own example
  contradicts it, so the code's session design is the intent; the prose is wrong.
- **Status:** open

## F-25: quotas.md denies the assignPlan API that exists (and that billing depends on)

- **Claims:** [quota#2], [quota#3]
- **Severity:** MED (stale: predates storage-backed plans; contradicts services.md,
  billing docs, and `tenant:billing:backfill`)
- **Doc text:** "Plans are declared statically… There is no `upsertPlan` / `assignPlan`
  API — pick the plan… from `plans.getPlan(tenant)`." (quotas.md:26-28)
- **Reality:** `QuotaService.assignPlan/getAssignedPlan/clearAssignedPlan` exist
  (quota_service.ts), `plans.storage: 'config-only'|'tenant_plans'|'auto'` governs them
  (config.ts:95), `quota_assignment.spec.ts` tests them, and billing's subscription sync
  assigns plans through them.
- **Resolution:** doc-fix — rewrite the Plans section around the three storage modes.
- **Status:** open

## F-26: branding.md method names don't match the service

- **Claims:** [branding#4], [branding#5]
- **Severity:** LOW/MED (snippets fail to compile)
- **Reality:** doc `update(tenantId, {…})` / `get(tenantId)` — code
  `upsert(tenantId, data)` / `getForTenant(tenantId)` (branding_service.ts). Encrypted
  SMTP columns + decrypt-on-read are real (crypto.ts; branding_service.spec.ts).
- **Resolution:** doc-fix — correct the names.
- **Status:** open

## F-27: sso.md API signatures don't match SsoService

- **Claims:** [sso#13], [sso#14], [sso#15]
- **Severity:** MED (snippets don't compile; the flow mechanics ARE right)
- **Reality:** doc `upsert(tenantId, {…})`, `startLogin(tenantId) → { authUrl, state }`,
  `handleCallback(tenantId, { code, state, cookieState })` — code surface is
  `getConfig(tenantId)`, `buildAuthUrl(config)`, `handleCallback(state, code)`
  (sso_service.ts:33,61,81). State TTL 600s, JWKS/discovery cache 3600s, clockTolerance,
  GETDEL state, nonce binding, discovery-issuer check, SSRF checks: all verified true.
- **Resolution:** doc-fix — correct the three signatures.
- **Status:** open

## F-28: audit.md's coverage list is mostly fictional — only impersonation writes audit rows

- **Claims:** [audit#1..6], [sat#16]
- **Severity:** HIGH (a compliance-relevant promise: the page lists six audited
  categories; five don't happen)
- **Doc text:** "What gets audited: tenant lifecycle (created, activated, suspended,
  soft_deleted, restored, purged); webhook subscription/delivery state changes; branding
  updates; SSO config updates; impersonation grants and revocations; quota threshold
  breaches." satellites/index.md adds "every satellite that mutates state writes an audit
  row when the audit satellite is enabled."
- **Reality:** grep of core+admin: `AuditLogService` is invoked ONLY by
  `impersonation_service.ts` (+ tenant:impersonate / tenant:repl commands). The admin
  controllers, lifecycle commands/jobs, webhook/branding/sso/quota services write no
  audit rows. The infrastructure (service + immutable table) is real and tested; the
  *automatic coverage* is not. (The example app writes its own rows via hooks — host
  code, not the package.)
- **Resolution:** doc-fix — audit.md documents `audit.log()` as the host API, lists
  impersonation as the only built-in writer, and shows the hook/event-listener pattern
  for lifecycle auditing. Auto-audit across satellites is feature-sized (action-name
  design, PII policy, ~10 call sites) — flagged for the roadmap rather than rushed into
  the audit branch. ALSO satellites/index.md sat#16 sentence gets removed/softened.
- **Status:** open

## F-29: admin-rest-api.md uses wrong HTTP verbs for the five lifecycle mutations

- **Claims:** [api#14..18] (+ [api#16] path)
- **Severity:** MED (copy-pasted curl examples 404/405)
- **Reality:** code routes are `POST /tenants/:id/activate|suspend|restore|maintenance`,
  `POST /tenants/:id/destroy`, `DELETE /tenants/:id/maintenance`
  (packages/admin/src/routes.ts:148-160). Doc says PUT for activate/suspend/restore/
  maintenance and `DELETE /tenants/{id}` (which doesn't exist). The GET/webhook/flag/
  audit-log routes match. The page also omits several real routes (queue/stats,
  impersonations, health/report, webhook update/retry, branding, sso, quotas, metrics) —
  acceptable if not claiming completeness, but worth a sweep while fixing.
- **Resolution:** doc-fix — correct the verbs/paths; ideally regenerate the table from
  openapi.json so it can't drift again.
- **Status:** open

## F-30: multi-region cookbook alerts on a Prometheus metric that doesn't exist

- **Claims:** [mregion#9]
- **Severity:** LOW/MED (an operator wiring the suggested alert gets a silent no-data
  alert)
- **Reality:** the exporter emits exactly: multitenancy_tenants_total,
  multitenancy_tenants_by_status, multitenancy_circuit_state,
  multitenancy_circuit_failures_total, multitenancy_circuit_successes_total,
  multitenancy_queue_jobs, multitenancy_uptime_seconds (metrics_exporter.ts). There is no
  `multitenancy_replica_lag_seconds`; lag is surfaced by `tenant:doctor
  --check=replica_lag`, not Prometheus.
- **Resolution:** doc-fix — replace the alert suggestion with the doctor-based check (or
  a textfile-exporter pattern). Adding the metric is a small feature — roadmap note.
- **Status:** open

## Addendum to F-17 (jobs.md)

jobs.md also claims InstallTenant "runs migrations" — `install_tenant.ts:36` only calls
`driver.provision()`; migrations are the separate `tenant:migrate` step (installation.md
got this right in commit 453518d). Fix in the same jobs.md rewrite.

import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { enforceQuota } from '@adonisjs-lasagna/saas-tenancy/middleware'
import { multitenancyRoutes } from '@adonisjs-lasagna/saas-tenancy/health'
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
import { multitenancyReportingRoutes } from '@adonisjs-lasagna/reporting'
import { multitenancyAiRoutes } from '@adonisjs-lasagna/ai/routes'

/**
 * Lazy controller imports keep the route file small and let the
 * framework instantiate controllers per request via the IoC container,
 * which is required for `@inject()`-decorated constructor parameters.
 */
const TenantsController = () => import('#app/controllers/demo/tenants_controller')
const BackofficeAuthController = () => import('#app/controllers/demo/backoffice_auth_controller')
const DemoAuthController = () => import('#app/controllers/demo/auth_controller')
const NotesController = () => import('#app/controllers/demo/notes_controller')
const QuotaController = () => import('#app/controllers/demo/quota_controller')
const DoctorController = () => import('#app/controllers/demo/doctor_controller')
const CircuitController = () => import('#app/controllers/demo/circuit_controller')
const AuditController = () => import('#app/controllers/demo/audit_controller')
const LogController = () => import('#app/controllers/demo/log_controller')
const WebhooksController = () => import('#app/controllers/demo/webhooks_controller')
const FeatureFlagsController = () => import('#app/controllers/demo/feature_flags_controller')
const BrandingController = () => import('#app/controllers/demo/branding_controller')
const SsoController = () => import('#app/controllers/demo/sso_controller')
const BillingController = () => import('#app/controllers/demo/billing_controller')
const CryptoController = () => import('#app/controllers/demo/crypto_controller')

/* ─── Operational endpoints (livez / readyz / healthz / metrics) ─────────── */
// `/livez` and `/readyz` stay public for k8s probes. `/metrics` leaks tenant
// enumeration + business KPIs, so it is fail-closed: gate it with the same auth
// as the admin API. (Pass `metricsMiddleware: false` only to mount it public
// behind a trusted network boundary.)
multitenancyRoutes({ metricsMiddleware: [middleware.auth({ guards: ['backoffice'] })] })

/* ─── Package admin REST API (backoffice-realm gated) ────────────────────── */
multitenancyAdminRoutes({
  prefix: '/admin',
  middleware: [middleware.auth({ guards: ['backoffice'] })],
  // Real identity only: the acting admin is the operator the backoffice guard
  // authenticated, nothing else. Returning null denies actions that need an
  // actor (an impersonation start answers 401), so a misconfigured mount
  // fails closed instead of attributing to a spoofable header.
  resolveAdminActor: (ctx) => ctx.auth.use('backoffice').user?.id ?? null,
})

/* ─── Stripe webhook receiver (ungated, in ignorePaths) ─────────────────── */
multitenancyBillingRoutes()

/* ─── Cross-tenant reporting dashboard (fail-closed, admin-gated) ─────────── */
// Fleet-wide analytics, so it carries the same admin auth as /admin and /metrics.
// `openapi: true` mounts /admin/reporting/openapi.json + /docs under the same auth.
multitenancyReportingRoutes({
  prefix: '/admin/reporting',
  middleware: [middleware.auth({ guards: ['backoffice'] })],
  openapi: true,
  // Cache dashboard responses; config.reporting.cache.invalidateOnFlush clears
  // them on every tenant:metrics:flush so the view stays fresh.
  cacheTtlMs: 60_000,
})

/* ─── AI gateway (@adonisjs-lasagna/ai): tenant-scoped, fail-closed mount ── */
// POST /ai/chat (SSE), /ai/embed, /ai/retrieve. TenantGuard FIRST per the mount
// contract; config.ai.authorizeAIAccess is the per-request membership gate. The
// demo runs fully offline through the mock providers registered in AppProvider.
multitenancyAiRoutes({ middleware: [middleware.tenantGuard()] })

/* ─── Impersonation verify probe ─────────────────────────────────────────── */
// Echoes the verified impersonation context attached by ImpersonationMiddleware,
// so a request carrying a token minted via the admin API can prove it resolves
// end to end (the e2e impersonation flow asserts on `impersonation`). No tenant
// guard: the middleware binds the token to its issuing tenant on its own.
router
  .get('/demo/impersonation-check', async (ctx: any) => {
    return ctx.response.ok({ impersonation: ctx.impersonation ?? null })
  })
  .use([middleware.impersonation()])

/* ─── Operator realm: login surface on the central (apex) plane ──────────── */
// Declared with router.central(): CentralOnlyMiddleware rejects any request
// that carries a tenant id, which is intended. Operators authenticate on the
// apex, never inside a tenant context. Login is rate-limited with the
// package's own middleware (on central routes it degrades to the shared
// per-IP bucket, and it is inert under app.inTest).
router.central(() => {
  router
    .post('/backoffice/login', [BackofficeAuthController, 'login'])
    .use(middleware.rateLimit({ limit: 10, windowSeconds: 60 }))
  router
    .get('/backoffice/me', [BackofficeAuthController, 'me'])
    .use(middleware.auth({ guards: ['backoffice'] }))
  router
    .delete('/backoffice/logout', [BackofficeAuthController, 'logout'])
    .use(middleware.auth({ guards: ['backoffice'] }))
})

/* ─── /demo: tenant CRUD (no tenant guard, no tenant context yet) ───────── */
router
  .group(() => {
    router.get('/tenants', [TenantsController, 'list'])
    router.post('/tenants', [TenantsController, 'create'])
    router.get('/tenants/:id', [TenantsController, 'show'])
    router.post('/tenants/:id/activate', [TenantsController, 'activate'])
    router.post('/tenants/:id/suspend', [TenantsController, 'suspend'])
    router.delete('/tenants/:id', [TenantsController, 'destroy'])
  })
  .prefix('/demo')

/* ─── /demo: tenant-scoped feature surface (TenantGuardMiddleware) ───────── */
router
  .group(() => {
    // Tenant realm: login inside the resolved tenant's context, so the
    // credential lookup and the minted token both live in that tenant's own
    // schema. Same rate limit shape as the operator login.
    router
      .post('/auth/login', [DemoAuthController, 'login'])
      .use(middleware.rateLimit({ limit: 10, windowSeconds: 60 }))
    router.get('/auth/me', [DemoAuthController, 'me']).use(middleware.auth({ guards: ['tenant'] }))
    router
      .delete('/auth/logout', [DemoAuthController, 'logout'])
      .use(middleware.auth({ guards: ['tenant'] }))

    // Schema isolation probe
    router.get('/connection', [TenantsController, 'connection'])

    // Notes (raw-SQL through the tenant connection) + per-day quota gate
    router.get('/notes', [NotesController, 'list'])
    router.get('/notes/read', [NotesController, 'listFromReplica'])
    router.post('/notes', [NotesController, 'create']).use(enforceQuota('apiCallsPerDay'))

    // Quotas / doctor / circuit / audit / contextual-logging probe
    router.get('/quota/state', [QuotaController, 'state'])
    router.post('/quota/track', [QuotaController, 'track'])
    router.get('/doctor', [DoctorController, 'run'])
    router.get('/circuit', [CircuitController, 'state'])
    router.get('/audit', [AuditController, 'list'])
    router.get('/log/emit', [LogController, 'emit'])

    // Webhook subscriptions + manual fire
    router.get('/webhooks', [WebhooksController, 'list'])
    router.post('/webhooks', [WebhooksController, 'subscribe'])
    router.post('/webhooks/fire', [WebhooksController, 'fire'])

    // Satellites: feature flags / branding / SSO
    router.get('/feature-flags', [FeatureFlagsController, 'list'])
    router.post('/feature-flags', [FeatureFlagsController, 'set'])
    router.delete('/feature-flags/:flag', [FeatureFlagsController, 'destroy'])
    router.get('/branding', [BrandingController, 'show'])
    router.put('/branding', [BrandingController, 'update'])
    router.get('/sso', [SsoController, 'show'])
    router.put('/sso', [SsoController, 'update'])

    // Billing (Stripe), added incrementally alongside the satellites above
    router.get('/billing', [BillingController, 'show'])
    router.post('/billing/checkout', [BillingController, 'checkout'])

    // Crypto (@adonisjs-lasagna/crypto): field encryption, blind-index search, shred
    router.post('/secure-notes', [CryptoController, 'create'])
    router.post('/secure-notes/search', [CryptoController, 'search'])
    router.get('/secure-notes/:subject', [CryptoController, 'show'])
    router.post('/secure-notes/:subject/shred', [CryptoController, 'shred'])
  })
  .prefix('/demo')
  .use(middleware.tenantGuard())
  // Feed the metrics pipeline: count every tenant-scoped request. bypassInTestEnv
  // is false so the e2e suite exercises the recording path (it resolves the tenant
  // from the request header even after the guard's async scope unwinds).
  .use([middleware.trackMetrics({ bypassInTestEnv: false })])

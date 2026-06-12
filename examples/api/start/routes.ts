import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { enforceQuota } from '@adonisjs-lasagna/saas-tenancy/middleware'
import { multitenancyRoutes } from '@adonisjs-lasagna/saas-tenancy/health'
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'

/**
 * Lazy controller imports — keeps the route file small and lets the
 * framework instantiate controllers per request via the IoC container,
 * which is required for `@inject()`-decorated constructor parameters.
 */
const TenantsController = () => import('#app/controllers/demo/tenants_controller')
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

/* ─── Operational endpoints (livez / readyz / healthz / metrics) ─────────── */
// `/livez` and `/readyz` stay public for k8s probes. `/metrics` leaks tenant
// enumeration + business KPIs, so it is fail-closed: gate it with the same auth
// as the admin API. (Pass `metricsMiddleware: false` only to mount it public
// behind a trusted network boundary.)
multitenancyRoutes({ metricsMiddleware: [middleware.demoAdminAuth()] })

/* ─── Package admin REST API (header-token gated) ────────────────────────── */
multitenancyAdminRoutes({
  prefix: '/admin',
  middleware: [middleware.demoAdminAuth()],
})

/* ─── Stripe webhook receiver (ungated — in ignorePaths) ─────────────────── */
multitenancyBillingRoutes()

/* ─── /demo: tenant CRUD (no tenant guard — no tenant context yet) ───────── */
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

    // Billing (Stripe) — added incrementally alongside the satellites above
    router.get('/billing', [BillingController, 'show'])
    router.post('/billing/checkout', [BillingController, 'checkout'])
  })
  .prefix('/demo')
  .use(middleware.tenantGuard())

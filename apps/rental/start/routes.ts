import router from '@adonisjs/core/services/router'
import { middleware } from '#start/kernel'
import { multitenancyRoutes } from '@adonisjs-lasagna/saas-tenancy/health'
import { multitenancyAdminRoutes } from '@adonisjs-lasagna/admin'
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
import { multitenancyReportingRoutes } from '@adonisjs-lasagna/reporting'
import { multitenancyAiRoutes } from '@adonisjs-lasagna/ai/routes'
import { enforceQuota } from '@adonisjs-lasagna/saas-tenancy/middleware'

/**
 * F1 spine routes. The operator console (admin satellite), the domain surface
 * and the Inertia pages are layered on in later phases; this file establishes
 * the two auth realms and a schema-isolation probe so the tenancy spine can be
 * verified end to end.
 */
const BackofficeAuthController = () => import('#app/controllers/auth/backoffice_auth_controller')
const TenantAuthController = () => import('#app/controllers/auth/tenant_auth_controller')
const ConsoleAuthController = () => import('#app/controllers/console/console_auth_controller')
const ConsoleHomeController = () => import('#app/controllers/console/console_home_controller')
const PagesController = () => import('#app/controllers/console/pages_controller')
const TenantsController = () => import('#app/controllers/admin/tenants_controller')
const FleetController = () => import('#app/controllers/tenant/fleet_controller')
const CustomersController = () => import('#app/controllers/tenant/customers_controller')
const BookingsController = () => import('#app/controllers/tenant/bookings_controller')
const BillingController = () => import('#app/controllers/tenant/billing_controller')
const FleetDocsController = () => import('#app/controllers/tenant/fleet_docs_controller')
const SettingsController = () => import('#app/controllers/tenant/settings_controller')

/* ─── Operational endpoints (livez / readyz / healthz / metrics) ─────────── */
// `/livez` and `/readyz` stay public for probes. `/metrics` leaks tenant
// enumeration + business KPIs, so it is gated for the operator realm — either a
// `bko_` token (API/scrapers) or a `web-backoffice` session (browser console).
multitenancyRoutes({
  metricsMiddleware: [middleware.auth({ guards: ['backoffice', 'web-backoffice'] })],
})

/* ─── Operator console: full package admin REST API (backoffice-gated) ───── */
// The complete tenant-lifecycle + per-tenant satellite console. The operator
// drives it from apex `localhost` with a bko_ token; `resolveAdminActor` returns
// the authenticated operator so impersonation + audit attribute to a real id.
// Accepts either operator credential: a `bko_` token (programmatic API + e2e)
// or a `web-backoffice` session (the Inertia console fetches these endpoints
// with the session cookie). The membership/tenant isolation is unaffected —
// these are cross-tenant operator routes addressed by `:id`.
multitenancyAdminRoutes({
  prefix: '/admin',
  middleware: [middleware.auth({ guards: ['backoffice', 'web-backoffice'] })],
  resolveAdminActor: (ctx) =>
    ctx.auth.use('web-backoffice').user?.id ?? ctx.auth.use('backoffice').user?.id ?? null,
})

/* ─── Billing webhook receiver (ungated, in ignorePaths) ─────────────────── */
multitenancyBillingRoutes()

/* ─── Cross-tenant reporting dashboard (admin-gated, OpenAPI) ─────────────── */
multitenancyReportingRoutes({
  prefix: '/admin/reporting',
  middleware: [middleware.auth({ guards: ['backoffice', 'web-backoffice'] })],
  openapi: true,
  cacheTtlMs: 60_000,
})

/* ─── AI fleet assistant (tenant-scoped, fail-closed mount) ──────────────── */
// POST /ai/chat (SSE), /ai/embed, /ai/retrieve. TenantGuard FIRST per the mount
// contract; config.ai.authorizeAIAccess is the per-request membership gate.
multitenancyAiRoutes({ middleware: [middleware.tenantGuard()] })

/* ─── Operator realm: login on the central (apex) plane ──────────────────── */
// Declared with router.central(): CentralOnlyMiddleware rejects any request
// that carries a company id. Operators authenticate on the apex `localhost`.
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

/* ─── Operator façade: company lifecycle (no company context) ────────────── */
// A thin stand-in for the full admin console (which arrives with the admin
// satellite). Gated on the operator realm; lives under /manage so it never
// collides with the satellite's /admin prefix.
router
  .group(() => {
    router.get('/tenants', [TenantsController, 'list'])
    router.post('/tenants', [TenantsController, 'create'])
    router.get('/tenants/:id', [TenantsController, 'show'])
    router.post('/tenants/:id/activate', [TenantsController, 'activate'])
    router.post('/tenants/:id/suspend', [TenantsController, 'suspend'])
    router.delete('/tenants/:id', [TenantsController, 'destroy'])
  })
  .prefix('/manage')
  .use(middleware.auth({ guards: ['backoffice'] }))

/* ─── Tenant realm: company-scoped surface (TenantGuardMiddleware) ────────── */
router
  .group(() => {
    // Login inside the resolved company's context, so the credential lookup and
    // the minted token both live in that company's own schema.
    router
      .post('/auth/login', [TenantAuthController, 'login'])
      .use(middleware.rateLimit({ limit: 10, windowSeconds: 60 }))
    router
      .get('/auth/me', [TenantAuthController, 'me'])
      .use(middleware.auth({ guards: ['tenant'] }))
    router
      .delete('/auth/logout', [TenantAuthController, 'logout'])
      .use(middleware.auth({ guards: ['tenant'] }))

    // Schema-isolation probe: returns the resolved company's named connection.
    router.get('/connection', [TenantsController, 'connection'])

    /* ─── Domain: fleet, customers, bookings (F2) ──────────────────────── */
    // All company-staff routes; token-guarded via the membership gate above.
    router.get('/catalog', [FleetController, 'catalog'])

    router.get('/locations', [FleetController, 'listLocations'])
    router.post('/locations', [FleetController, 'createLocation'])

    router.get('/categories', [FleetController, 'listCategories'])
    router.post('/categories', [FleetController, 'createCategory'])

    router.get('/vehicles', [FleetController, 'listVehicles'])
    // Fleet size is a plan quota: 429 once the company hits vehiclesPerTenant.
    router
      .post('/vehicles', [FleetController, 'createVehicle'])
      .use(enforceQuota('vehiclesPerTenant'))
    router.get('/vehicles/available', [FleetController, 'availability'])
    router.get('/vehicles/:id', [FleetController, 'showVehicle'])
    router.post('/vehicles/:id/status', [FleetController, 'setVehicleStatus'])

    router.get('/customers', [CustomersController, 'list'])
    router.post('/customers', [CustomersController, 'create'])
    router.post('/customers/search', [CustomersController, 'search'])
    router.get('/customers/:id', [CustomersController, 'show'])
    // Exercise a renter's erasure right → crypto-shred (410 on re-read).
    router.post('/customers/:id/shred', [CustomersController, 'shred'])

    router.get('/bookings', [BookingsController, 'list'])
    // Monthly booking volume is a plan quota.
    router.post('/bookings', [BookingsController, 'create']).use(enforceQuota('bookingsPerMonth'))
    router.get('/bookings/:id', [BookingsController, 'show'])
    router.post('/bookings/:id/confirm', [BookingsController, 'confirm'])
    router.post('/bookings/:id/activate', [BookingsController, 'activate'])
    router.post('/bookings/:id/complete', [BookingsController, 'complete'])
    router.post('/bookings/:id/cancel', [BookingsController, 'cancel'])
    router.post('/bookings/:id/invoice', [BookingsController, 'invoice'])

    // RAG corpus for the fleet assistant.
    router.get('/fleet-docs', [FleetDocsController, 'list'])
    router.post('/fleet-docs', [FleetDocsController, 'create'])

    // Company SaaS subscription (billing satellite).
    router.get('/billing', [BillingController, 'show'])
    router.post('/billing/checkout', [BillingController, 'checkout'])
    router.post('/billing/portal', [BillingController, 'portal'])

    // Company self-service settings (branding / feature flags / SSO), each scoped
    // to the caller's own company. These JSON routes deliberately sit under
    // /settings/* so they never collide with the `/settings` Inertia page shell.
    router.get('/settings/branding', [SettingsController, 'brandingShow'])
    router.put('/settings/branding', [SettingsController, 'brandingUpdate'])
    router.get('/settings/flags', [SettingsController, 'flagsList'])
    router.put('/settings/flags/:flag', [SettingsController, 'flagSet'])
    router.get('/settings/sso', [SettingsController, 'ssoShow'])
    router.put('/settings/sso', [SettingsController, 'ssoUpdate'])
    router.post('/settings/sso/disable', [SettingsController, 'ssoDisable'])
  })
  .use(middleware.tenantGuard())
  // Feed the metrics pipeline: count every company-scoped request.
  .use([middleware.trackMetrics({ bypassInTestEnv: false })])

/* ─── Browser consoles (Inertia + React, session guards) ─────────────────── */
// One universal group serves BOTH consoles: UniversalMiddleware resolves the
// company when the host carries one (never failing on the apex), so the same
// routes render the operator console on `localhost` and a company's staff
// console on `<slug>.localhost`. The controllers branch on the resolved host and
// pick the matching `web-*` session guard. `/login` is a public entry point (see
// the membership authorizer allowlist); the home shell bounces anonymice there.
router.universal(() => {
  router.get('/login', [ConsoleAuthController, 'show'])
  router
    .post('/login', [ConsoleAuthController, 'store'])
    .use(middleware.rateLimit({ limit: 10, windowSeconds: 60 }))
  router.post('/logout', [ConsoleAuthController, 'destroy'])
  router.get('/', [ConsoleHomeController, 'index'])

  // Company staff pages — only on a company host, only for a pinned web-tenant
  // session (webAuth bounces the wrong realm / anonymous visitors).
  // Page-shell paths deliberately differ from the JSON API paths the pages fetch
  // (`/customers`, `/bookings`, `/billing` are the tenant-guarded data routes) —
  // a shared path would be a duplicate-route boot error. The domain names read
  // better anyway: renters, reservations, the company's own subscription.
  const tenantPage = middleware.webAuth({ realm: 'tenant' })
  router.get('/fleet', [PagesController, 'fleet']).use(tenantPage)
  router.get('/renters', [PagesController, 'customers']).use(tenantPage)
  router.get('/reservations', [PagesController, 'bookings']).use(tenantPage)
  router.get('/subscription', [PagesController, 'billing']).use(tenantPage)
  router.get('/assistant', [PagesController, 'assistant']).use(tenantPage)
  router.get('/knowledge', [PagesController, 'knowledge']).use(tenantPage)
  router.get('/settings', [PagesController, 'settings']).use(tenantPage)

  // Operator pages — apex only, web-backoffice session.
  const operatorPage = middleware.webAuth({ realm: 'operator' })
  router.get('/companies/:id', [PagesController, 'company']).use(operatorPage)
  router.get('/reporting', [PagesController, 'reporting']).use(operatorPage)
  router.get('/health', [PagesController, 'health']).use(operatorPage)
})

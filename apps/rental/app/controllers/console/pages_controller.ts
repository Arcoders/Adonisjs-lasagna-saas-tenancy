import type { HttpContext } from '@adonisjs/core/http'

/**
 * Thin Inertia shells for the console pages beyond the home dashboard. Each just
 * names its React page; the data is hydrated client-side from the REST surfaces
 * (the tenant domain API for company pages, the admin satellite for the operator
 * company view). Auth + realm are enforced by the `webAuth` route middleware,
 * and `company` rides in shared props — so these methods carry no logic.
 */
export default class PagesController {
  /* ─── Company staff pages (realm: tenant) ──────────────────────────── */
  async fleet({ inertia }: HttpContext) {
    return inertia.render('tenant/fleet', {})
  }
  async customers({ inertia }: HttpContext) {
    return inertia.render('tenant/customers', {})
  }
  async bookings({ inertia }: HttpContext) {
    return inertia.render('tenant/bookings', {})
  }
  async billing({ inertia }: HttpContext) {
    return inertia.render('tenant/billing', {})
  }
  async assistant({ inertia }: HttpContext) {
    return inertia.render('tenant/assistant', {})
  }
  async knowledge({ inertia }: HttpContext) {
    return inertia.render('tenant/knowledge', {})
  }

  // Company self-service: branding, feature flags and SSO scoped to the caller's
  // own company. The data is hydrated from the tenant-scoped `/settings/*` routes.
  async settings({ inertia }: HttpContext) {
    return inertia.render('tenant/settings', {})
  }

  /* ─── Operator pages (realm: operator) ─────────────────────────────── */
  // The per-company control panel (satellite tabs). The id addresses the tenant
  // for the admin satellite's `/admin/tenants/:id/*` endpoints.
  async company({ inertia, params }: HttpContext) {
    return inertia.render('operator/company', { tenantId: params.id })
  }

  // Cross-tenant reporting dashboard (reporting satellite under /admin/reporting).
  async reporting({ inertia }: HttpContext) {
    return inertia.render('operator/reporting', {})
  }

  // Platform health + per-company doctor + queue depth (admin satellite /admin).
  async health({ inertia }: HttpContext) {
    return inertia.render('operator/health', {})
  }
}

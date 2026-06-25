import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'
import { setFlagValidator } from '#app/validators/flags_validator'

/**
 * Per-tenant feature flag CRUD. Real apps expose this via an admin UI; the
 * demo route is deliberately bare so the `FeatureFlagService` surface stays
 * visible.
 */
@inject()
export default class FeatureFlagsController {
  constructor(private readonly flags: FeatureFlagService) {}

  async list({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const rows = await this.flags.listForTenant(tenant.id)
    return response.ok({
      tenantId: tenant.id,
      flags: rows.map((r) => ({
        flag: r.flag,
        enabled: r.enabled,
        config: r.config ?? null,
      })),
    })
  }

  async set({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const payload = await request.validateUsing(setFlagValidator)
    const enabled = payload.enabled !== false
    const row = await this.flags.set(tenant.id, payload.flag, enabled, payload.config)
    return response.created({
      tenantId: tenant.id,
      flag: row.flag,
      enabled: row.enabled,
      config: row.config ?? null,
    })
  }

  async destroy({ params, request, response }: HttpContext) {
    const tenant = await request.tenant()
    await this.flags.delete(tenant.id, params.flag)
    return response.ok({ deleted: true, flag: params.flag })
  }
}

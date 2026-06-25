import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { trackQuotaValidator } from '#app/validators/quota_validator'
import type { DemoMeta } from '#app/models/backoffice/tenant'

/**
 * - GET  /demo/quota/state  → resolved plan + limits + current usage
 * - POST /demo/quota/track  → bump a rolling counter (does not enforce)
 *
 * The blocking variant lives on `POST /demo/notes` via the
 * `enforceQuota('apiCallsPerDay')` middleware in `start/routes.ts`.
 */
@inject()
export default class QuotaController {
  constructor(private readonly quota: QuotaService) {}

  async state({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const snapshot = await this.quota.snapshot(tenant)
    return response.ok({ tenantId: tenant.id, ...snapshot })
  }

  async track({ request, response }: HttpContext) {
    const tenant = await request.tenant<DemoMeta>()
    const payload = await request.validateUsing(trackQuotaValidator)
    const current = await this.quota.track(tenant, payload.quota, payload.amount ?? 1)
    return response.ok({ quota: payload.quota, current })
  }
}

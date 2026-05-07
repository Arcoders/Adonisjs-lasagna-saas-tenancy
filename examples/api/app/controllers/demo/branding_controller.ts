import type { HttpContext } from '@adonisjs/core/http'
import { BrandingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { updateBrandingValidator } from '#app/validators/branding_validator'

const branding = new BrandingService()

/**
 * Read / write tenant branding via `BrandingService`. Returns the
 * `renderEmailContext()` shape so callers see the resolved defaults even
 * when no row has been persisted yet.
 */
export default class BrandingController {
  async show({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const row = await branding.getForTenant(tenant.id)
    return response.ok({
      tenantId: tenant.id,
      hasRow: row !== null,
      branding: branding.renderEmailContext(row),
    })
  }

  async update({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const payload = await request.validateUsing(updateBrandingValidator)
    const row = await branding.upsert(tenant.id, {
      fromName: payload.fromName ?? null,
      fromEmail: payload.fromEmail ?? null,
      logoUrl: payload.logoUrl ?? null,
      primaryColor: payload.primaryColor ?? null,
      supportUrl: payload.supportUrl ?? null,
      emailFooter: payload.emailFooter ?? null,
    })
    return response.ok({
      tenantId: tenant.id,
      branding: branding.renderEmailContext(row),
    })
  }
}

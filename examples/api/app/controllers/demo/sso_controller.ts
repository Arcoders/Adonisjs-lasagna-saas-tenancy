import type { HttpContext } from '@adonisjs/core/http'
import { SsoService } from '@adonisjs-lasagna/sso'
import { updateSsoValidator } from '#app/validators/sso_validator'

const sso = new SsoService()

/**
 * Read / write tenant SSO config. The `clientSecret` is never echoed back —
 * we expose a `hasClientSecret` boolean so callers can tell whether one is
 * stored without leaking the value.
 */
export default class SsoController {
  async show({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const config = await sso.getConfig(tenant.id)
    if (!config) return response.ok({ tenantId: tenant.id, configured: false })
    return response.ok({
      tenantId: tenant.id,
      configured: true,
      provider: config.provider,
      clientId: config.clientId,
      issuerUrl: config.issuerUrl,
      redirectUri: config.redirectUri,
      scopes: config.scopes,
      enabled: config.enabled,
      hasClientSecret: Boolean(config.clientSecret),
    })
  }

  async update({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const payload = await request.validateUsing(updateSsoValidator)
    const row = await sso.upsertConfig(tenant.id, {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      issuerUrl: payload.issuerUrl,
      redirectUri: payload.redirectUri,
      scopes: payload.scopes,
    })
    return response.ok({
      tenantId: tenant.id,
      configured: true,
      provider: row.provider,
      clientId: row.clientId,
      issuerUrl: row.issuerUrl,
      redirectUri: row.redirectUri,
      scopes: row.scopes,
      enabled: row.enabled,
      hasClientSecret: Boolean(row.clientSecret),
    })
  }
}

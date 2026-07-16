import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import { SsoService } from '@adonisjs-lasagna/sso'
import { updateSsoValidator } from '#app/validators/sso_validator'

/**
 * Read / write tenant SSO config. The `clientSecret` is never echoed back. We
 * expose a `hasClientSecret` boolean so callers can tell whether one is stored
 * without leaking the value.
 */
@inject()
export default class SsoController {
  constructor(private readonly sso: SsoService) {}

  async show({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const config = await this.sso.getConfig(tenant.id)
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
    const row = await this.sso.upsertConfig(tenant.id, {
      clientId: payload.clientId,
      clientSecret: payload.clientSecret,
      issuerUrl: payload.issuerUrl,
      redirectUri: payload.redirectUri,
      // `scopes` is an optional field on the satellite's own config type; omit
      // the key entirely when absent rather than passing `undefined`.
      ...(payload.scopes !== undefined ? { scopes: payload.scopes } : {}),
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

import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import SsoService from '../../services/sso_service.js'
import TenantSsoConfig from '../../models/satellites/tenant_sso_config.js'
import { loadTenantOr404, isNonEmptyString, validateExternalHttpsUrl } from './helpers.js'

/**
 * Strips secret material before serializing. Admins can see whether a config
 * exists and whether a secret is set, but never the secret itself.
 */
function serialize(c: TenantSsoConfig | null) {
  if (!c) return null
  return {
    id: c.id,
    tenantId: c.tenantId,
    provider: c.provider,
    clientId: c.clientId,
    issuerUrl: c.issuerUrl,
    redirectUri: c.redirectUri,
    scopes: c.scopes,
    enabled: c.enabled,
    hasClientSecret: !!c.clientSecret,
    createdAt: c.createdAt?.toISO?.() ?? null,
    updatedAt: c.updatedAt?.toISO?.() ?? null,
  }
}

function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

export default class SsoController {
  async show(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const svc = await app.container.make(SsoService)
    const config = await svc.getConfig(tenant.id)
    return ctx.response.ok({ data: serialize(config) })
  }

  async update(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    const clientId = ctx.request.input('clientId')
    const clientSecret = ctx.request.input('clientSecret')
    const issuerUrl = ctx.request.input('issuerUrl')
    const redirectUri = ctx.request.input('redirectUri')
    const scopes = ctx.request.input('scopes')

    if (!isNonEmptyString(clientId)) return ctx.response.badRequest({ error: 'clientId_required' })
    if (!isNonEmptyString(clientSecret)) {
      return ctx.response.badRequest({ error: 'clientSecret_required' })
    }
    // issuerUrl is fetched server-side by SsoService (discovery + JWKS), so
    // it MUST clear the SSRF guard: https only, no loopback / RFC 1918 /
    // link-local / cloud-metadata hosts. redirectUri is only echoed to the
    // IdP — the package never fetches it — so the loose http(s) check is OK.
    const issuerErr = validateExternalHttpsUrl(issuerUrl)
    if (issuerErr) return ctx.response.badRequest({ error: `issuerUrl_${issuerErr}` })
    if (!isHttpsUrl(redirectUri)) return ctx.response.badRequest({ error: 'redirectUri_invalid' })
    if (
      scopes !== undefined &&
      (!Array.isArray(scopes) || !scopes.every(isNonEmptyString))
    ) {
      return ctx.response.badRequest({ error: 'scopes_must_be_string_array' })
    }

    const svc = await app.container.make(SsoService)
    const config = await svc.upsertConfig(tenant.id, {
      clientId,
      clientSecret,
      issuerUrl,
      redirectUri,
      scopes: Array.isArray(scopes) ? scopes : undefined,
    })
    return ctx.response.ok({ data: serialize(config) })
  }

  async disable(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const config = await TenantSsoConfig.query().where('tenant_id', tenant.id).first()
    if (!config) return ctx.response.notFound({ error: 'sso_config_not_found' })
    config.enabled = false
    await config.save()
    return ctx.response.ok({ data: serialize(config) })
  }
}

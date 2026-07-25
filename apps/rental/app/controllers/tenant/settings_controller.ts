import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { BrandingService, FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'
import { currentTenant } from '#app/helpers/current_tenant'

/**
 * Company self-service settings: branding, feature flags and SSO, each scoped to
 * the CALLER'S OWN company. It mirrors the admin satellite's per-tenant
 * controllers but resolves the tenant from the request context (never a `:id`
 * path param), so a company manages only itself — the tenant guard + membership
 * gate already proved it belongs here. Lives under the tenant-guarded route group.
 *
 * The same underlying core services back both surfaces (BrandingService,
 * FeatureFlagService, and the optional SsoService peer), so the operator console
 * and the company console never drift.
 */

/** The flags a company may flip itself. Everything else stays operator-only. */
const SELF_SERVICE_FLAGS = ['online_checkin', 'dynamic_pricing', 'ai_assistant'] as const

type SsoModule = typeof import('@adonisjs-lasagna/sso')

export default class SettingsController {
  /* ─── Branding ─────────────────────────────────────────────────────── */
  async brandingShow({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const svc = await app.container.make(BrandingService)
    return response.ok({ data: await svc.getForTenant(tenant.id) })
  }

  async brandingUpdate({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)

    const fromName = request.input('fromName')
    const fromEmail = request.input('fromEmail')
    const logoUrl = request.input('logoUrl')
    const primaryColor = request.input('primaryColor')
    const supportUrl = request.input('supportUrl')

    if (isPresent(fromEmail) && !String(fromEmail).includes('@')) {
      return response.badRequest({ error: 'invalid_fromEmail' })
    }
    if (isPresent(logoUrl) && !looksLikeUrl(logoUrl)) {
      return response.badRequest({ error: 'invalid_logoUrl' })
    }
    if (isPresent(supportUrl) && !looksLikeUrl(supportUrl)) {
      return response.badRequest({ error: 'invalid_supportUrl' })
    }
    if (isPresent(primaryColor) && !/^#(?:[0-9a-fA-F]{3}){1,2}$/.test(String(primaryColor))) {
      return response.badRequest({ error: 'invalid_primaryColor' })
    }

    const svc = await app.container.make(BrandingService)
    // An empty field clears the value (null); an absent field is treated the same
    // way here since the form submits every field.
    const branding = await svc.upsert(tenant.id, {
      fromName: emptyToNull(fromName),
      fromEmail: emptyToNull(fromEmail),
      logoUrl: emptyToNull(logoUrl),
      primaryColor: emptyToNull(primaryColor),
      supportUrl: emptyToNull(supportUrl),
    })
    return response.ok({ data: branding })
  }

  /* ─── Feature flags ────────────────────────────────────────────────── */
  async flagsList({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const svc = await app.container.make(FeatureFlagService)
    return response.ok({
      data: await svc.listForTenant(tenant.id),
      selfServiceable: SELF_SERVICE_FLAGS,
    })
  }

  async flagSet({ request, response, params }: HttpContext) {
    const tenant = await currentTenant(request)
    const flag = String(params.flag)
    if (!SELF_SERVICE_FLAGS.includes(flag as (typeof SELF_SERVICE_FLAGS)[number])) {
      return response.forbidden({ error: 'flag_not_self_serviceable' })
    }
    const enabled = request.input('enabled')
    if (typeof enabled !== 'boolean') {
      return response.badRequest({ error: 'enabled_must_be_boolean' })
    }
    const svc = await app.container.make(FeatureFlagService)
    return response.ok({ data: await svc.set(tenant.id, flag, enabled) })
  }

  /* ─── SSO (optional @adonisjs-lasagna/sso peer) ────────────────────── */
  async ssoShow({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const sso = await loadSso()
    if (!sso) return ssoNotInstalled(response)
    // Query the model directly (not SsoService.getConfig, which hides disabled
    // configs) so a company can still see + re-enable one it turned off.
    const config = await sso.TenantSsoConfig.query().where('tenant_id', tenant.id).first()
    return response.ok({ data: serializeSso(config) })
  }

  async ssoUpdate({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const sso = await loadSso()
    if (!sso) return ssoNotInstalled(response)

    const clientId = request.input('clientId')
    const clientSecret = request.input('clientSecret')
    const issuerUrl = request.input('issuerUrl')
    const redirectUri = request.input('redirectUri')
    const scopes = request.input('scopes')

    if (!isPresent(clientId)) return response.badRequest({ error: 'clientId_required' })
    if (!isPresent(clientSecret)) return response.badRequest({ error: 'clientSecret_required' })
    if (!isHttpsUrl(redirectUri)) return response.badRequest({ error: 'redirectUri_invalid' })
    if (scopes !== undefined && (!Array.isArray(scopes) || !scopes.every(isPresent))) {
      return response.badRequest({ error: 'scopes_must_be_string_array' })
    }

    const svc = await app.container.make(sso.SsoService)
    try {
      // upsertConfig fetches issuerUrl server-side (OIDC discovery + JWKS), so it
      // SSRF-guards the URL and rejects a private/metadata/non-https host. It also
      // AES-encrypts the clientSecret at rest.
      const config = await svc.upsertConfig(tenant.id, {
        clientId,
        clientSecret,
        issuerUrl,
        redirectUri,
        ...(Array.isArray(scopes) ? { scopes } : {}),
      })
      return response.ok({ data: serializeSso(config) })
    } catch (error) {
      return response.badRequest({
        error: 'sso_config_rejected',
        message: (error as Error).message,
      })
    }
  }

  async ssoDisable({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    const sso = await loadSso()
    if (!sso) return ssoNotInstalled(response)
    const config = await sso.TenantSsoConfig.query().where('tenant_id', tenant.id).first()
    if (!config) return response.notFound({ error: 'sso_config_not_found' })
    if (!config.enabled) return response.ok({ data: serializeSso(config), unchanged: true })
    config.enabled = false
    await config.save()
    return response.ok({ data: serializeSso(config) })
  }
}

/* ─── helpers ──────────────────────────────────────────────────────────── */

function isPresent(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}

function emptyToNull(value: unknown): string | null {
  return isPresent(value) ? String(value).trim() : null
}

function looksLikeUrl(value: unknown): boolean {
  try {
    const u = new URL(String(value))
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

function isHttpsUrl(value: unknown): boolean {
  try {
    return new URL(String(value)).protocol === 'https:'
  } catch {
    return false
  }
}

async function loadSso(): Promise<SsoModule | null> {
  try {
    return await import('@adonisjs-lasagna/sso')
  } catch {
    return null
  }
}

function ssoNotInstalled(response: HttpContext['response']) {
  return response.status(501).send({ error: 'sso_not_installed' })
}

/** Never serialize the encrypted clientSecret; expose only whether one is set. */
function serializeSso(c: InstanceType<SsoModule['TenantSsoConfig']> | null) {
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

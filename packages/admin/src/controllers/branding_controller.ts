import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { BrandingService, type BrandingData } from '@adonisjs-lasagna/saas-tenancy/services'
import { type TenantBranding } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { loadTenantOr404, auditAdminAction } from './helpers.js'
import { looksLikeUrl, pickIfDefined } from './pure.js'

function serialize(b: TenantBranding | null) {
  if (!b) return null
  return {
    tenantId: b.tenantId,
    fromName: b.fromName,
    fromEmail: b.fromEmail,
    logoUrl: b.logoUrl,
    primaryColor: b.primaryColor,
    supportUrl: b.supportUrl,
    emailFooter: b.emailFooter,
    createdAt: b.createdAt?.toISO?.() ?? null,
    updatedAt: b.updatedAt?.toISO?.() ?? null,
  }
}

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}){1,2}$/

export default class BrandingController {
  async show(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const svc = await app.container.make(BrandingService)
    const branding = await svc.getForTenant(tenant.id)
    return ctx.response.ok({ data: serialize(branding) })
  }

  async update(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    const body = ctx.request.body()
    let data: BrandingData
    try {
      // `pickIfDefined` returns `undefined` for an absent key and `null` to
      // clear the column. Under exactOptionalPropertyTypes an absent key must be
      // omitted (not set to `undefined`), so each field is spread in only when it
      // was provided; a `null` still flows through to clear the stored value.
      const fromName = pickIfDefined<string>(body, 'fromName', (v) => typeof v === 'string')
      const fromEmail = pickIfDefined<string>(
        body,
        'fromEmail',
        (v) => typeof v === 'string' && /@/.test(v)
      )
      const logoUrl = pickIfDefined<string>(body, 'logoUrl', looksLikeUrl)
      const primaryColor = pickIfDefined<string>(
        body,
        'primaryColor',
        (v) => typeof v === 'string' && HEX_COLOR.test(v)
      )
      const supportUrl = pickIfDefined<string>(body, 'supportUrl', looksLikeUrl)
      const emailFooter = pickIfDefined<Record<string, unknown>>(
        body,
        'emailFooter',
        (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
      )
      data = {
        ...(fromName !== undefined ? { fromName } : {}),
        ...(fromEmail !== undefined ? { fromEmail } : {}),
        ...(logoUrl !== undefined ? { logoUrl } : {}),
        ...(primaryColor !== undefined ? { primaryColor } : {}),
        ...(supportUrl !== undefined ? { supportUrl } : {}),
        ...(emailFooter !== undefined ? { emailFooter } : {}),
      }
    } catch (err: any) {
      // Stable error codes only — error message is `invalid_<key>` from
      // pickIfDefined, never a raw exception string.
      const code =
        typeof err?.message === 'string' && /^invalid_[a-zA-Z]+$/.test(err.message)
          ? err.message
          : 'invalid_branding_payload'
      return ctx.response.badRequest({ error: code })
    }

    const svc = await app.container.make(BrandingService)
    const branding = await svc.upsert(tenant.id, data)
    // `changed` is the set of branding keys the caller actually supplied
    // (pickIfDefined leaves absent keys undefined). No secret material here.
    const changed = Object.entries(data)
      .filter(([, v]) => v !== undefined)
      .map(([k]) => k)
    await auditAdminAction(ctx, 'admin:branding:update', tenant.id, { changed })
    return ctx.response.ok({ data: serialize(branding) })
  }
}

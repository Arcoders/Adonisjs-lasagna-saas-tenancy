import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { BrandingService, type BrandingData } from '@adonisjs-lasagna/saas-tenancy/services'
import { type TenantBranding } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { loadTenantOr404 } from './helpers.js'
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
      data = {
        fromName: pickIfDefined<string>(body, 'fromName', (v) => typeof v === 'string'),
        fromEmail: pickIfDefined<string>(
          body,
          'fromEmail',
          (v) => typeof v === 'string' && /@/.test(v)
        ),
        logoUrl: pickIfDefined<string>(body, 'logoUrl', looksLikeUrl),
        primaryColor: pickIfDefined<string>(
          body,
          'primaryColor',
          (v) => typeof v === 'string' && HEX_COLOR.test(v)
        ),
        supportUrl: pickIfDefined<string>(body, 'supportUrl', looksLikeUrl),
        emailFooter: pickIfDefined<Record<string, unknown>>(
          body,
          'emailFooter',
          (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
        ),
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
    return ctx.response.ok({ data: serialize(branding) })
  }
}

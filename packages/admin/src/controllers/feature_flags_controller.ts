import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import { FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'
import { type TenantFeatureFlag } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { loadTenantOr404, isNonEmptyString } from './helpers.js'

function serialize(f: TenantFeatureFlag) {
  return {
    id: f.id,
    tenantId: f.tenantId,
    flag: f.flag,
    enabled: f.enabled,
    config: f.config,
    expiresAt: f.expiresAt?.toISO?.() ?? null,
    createdAt: f.createdAt?.toISO?.() ?? null,
    updatedAt: f.updatedAt?.toISO?.() ?? null,
  }
}

/**
 * Parse an optional `expiresAt` request input. Returns `{ ok: true, value }`
 * with a `DateTime` (or `null` when the field is absent/empty — which clears
 * any stored expiry, consistent with how `config` is handled), or
 * `{ ok: false }` when the value is present but not a valid ISO timestamp.
 */
function parseExpiresAt(raw: unknown): { ok: true; value: DateTime | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false }
  const dt = DateTime.fromISO(raw)
  if (!dt.isValid) return { ok: false }
  return { ok: true, value: dt }
}

export default class FeatureFlagsController {
  async list(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const svc = await app.container.make(FeatureFlagService)
    const flags = await svc.listForTenant(tenant.id)
    return ctx.response.ok({ data: flags.map(serialize) })
  }

  async create(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    const flag = ctx.request.input('flag')
    const enabled = ctx.request.input('enabled')
    const config = ctx.request.input('config')

    if (!isNonEmptyString(flag)) {
      return ctx.response.badRequest({ error: 'flag_required' })
    }
    if (typeof enabled !== 'boolean') {
      return ctx.response.badRequest({ error: 'enabled_must_be_boolean' })
    }
    const expiresAt = parseExpiresAt(ctx.request.input('expiresAt'))
    if (!expiresAt.ok) {
      return ctx.response.badRequest({ error: 'invalid_expires_at' })
    }

    const svc = await app.container.make(FeatureFlagService)
    const row = await svc.set(tenant.id, flag, enabled, config ?? undefined, expiresAt.value)
    return ctx.response.created({ data: serialize(row) })
  }

  async update(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    const flag = ctx.params.flagKey
    const enabled = ctx.request.input('enabled')
    const config = ctx.request.input('config')

    if (typeof enabled !== 'boolean') {
      return ctx.response.badRequest({ error: 'enabled_must_be_boolean' })
    }
    const expiresAt = parseExpiresAt(ctx.request.input('expiresAt'))
    if (!expiresAt.ok) {
      return ctx.response.badRequest({ error: 'invalid_expires_at' })
    }

    const svc = await app.container.make(FeatureFlagService)
    const row = await svc.set(tenant.id, flag, enabled, config ?? undefined, expiresAt.value)
    return ctx.response.ok({ data: serialize(row) })
  }

  async destroy(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const svc = await app.container.make(FeatureFlagService)
    await svc.delete(tenant.id, ctx.params.flagKey)
    return ctx.response.noContent()
  }
}

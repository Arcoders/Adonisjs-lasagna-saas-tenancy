import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { FeatureFlagService } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantFeatureFlag } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { loadTenantOr404, isNonEmptyString, auditAdminAction } from './helpers.js'
import { parseExpiresAt } from './pure.js'

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
    await auditAdminAction(ctx, 'admin:feature_flag:create', tenant.id, {
      flag,
      enabled,
      hasExpiry: expiresAt.value != null,
    })
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
    await auditAdminAction(ctx, 'admin:feature_flag:update', tenant.id, {
      flag,
      enabled,
      hasExpiry: expiresAt.value != null,
    })
    return ctx.response.ok({ data: serialize(row) })
  }

  async destroy(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    // Load-and-verify before deleting: `FeatureFlagService.delete` issues a
    // `DELETE … WHERE` that silently no-ops on a missing flag, so a blind delete
    // would let us audit a removal that never happened. 404 if the flag is not
    // set, and only audit a real deletion.
    const flagKey = ctx.params.flagKey
    const existing = await TenantFeatureFlag.query()
      .where('tenant_id', tenant.id)
      .where('flag', flagKey)
      .first()
    if (!existing) return ctx.response.notFound({ error: 'feature_flag_not_found' })

    const svc = await app.container.make(FeatureFlagService)
    await svc.delete(tenant.id, flagKey)
    await auditAdminAction(ctx, 'admin:feature_flag:delete', tenant.id, { flag: flagKey })
    return ctx.response.noContent()
  }
}

import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import FeatureFlagService from '../../services/feature_flag_service.js'
import TenantFeatureFlag from '../../models/satellites/tenant_feature_flag.js'
import { loadTenantOr404, isNonEmptyString } from './helpers.js'

function serialize(f: TenantFeatureFlag) {
  return {
    id: f.id,
    tenantId: f.tenantId,
    flag: f.flag,
    enabled: f.enabled,
    config: f.config,
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

    const svc = await app.container.make(FeatureFlagService)
    const row = await svc.set(tenant.id, flag, enabled, config ?? undefined)
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

    const svc = await app.container.make(FeatureFlagService)
    const row = await svc.set(tenant.id, flag, enabled, config ?? undefined)
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

import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import MetricsService from '../../services/metrics_service.js'
import TenantMetric from '../../models/satellites/tenant_metric.js'
import { loadTenantOr404, clamp } from './helpers.js'

function serialize(m: TenantMetric) {
  return {
    tenantId: m.tenantId,
    period: m.period,
    requestCount: m.requestCount,
    errorCount: m.errorCount,
    bandwidthBytes: m.bandwidthBytes,
  }
}

export default class MetricsController {
  async list(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return
    const days = clamp(ctx.request.input('days'), 1, 365, 30)
    const svc = await app.container.make(MetricsService)
    const rows = await svc.getForTenant(tenant.id, days)
    return ctx.response.ok({ data: rows.map(serialize), days })
  }
}

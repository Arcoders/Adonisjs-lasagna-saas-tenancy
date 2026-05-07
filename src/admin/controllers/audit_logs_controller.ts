import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import AuditLogService from '../../services/audit_log_service.js'
import { loadTenantOr404, clamp } from './helpers.js'

export default class AuditLogsController {
  async list(ctx: HttpContext) {
    const tenant = await loadTenantOr404(ctx)
    if (!tenant) return

    // Page is hard-capped at 1000 to prevent OFFSET-based DOS — Postgres
    // OFFSET is O(n), so `?page=10000&limit=200` reads + discards 2M
    // rows. Callers walking deep history should pass `from`/`to` (ISO 8601)
    // to switch the index from full-scan to range-scan on (tenant_id, created_at).
    const page = clamp(ctx.request.input('page'), 1, 1000, 1)
    const limit = clamp(ctx.request.input('limit'), 1, 200, 50)
    const from = parseDate(ctx.request.input('from'))
    const to = parseDate(ctx.request.input('to'))
    if (from && to && from > to) {
      return ctx.response.badRequest({ error: '`from` must be on or before `to`' })
    }

    const svc = await app.container.make(AuditLogService)
    const paginated = await svc.listForTenant(tenant.id, page, limit, { from, to })
    return ctx.response.ok(paginated)
  }
}

function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d
}

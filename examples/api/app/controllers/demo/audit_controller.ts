import type { HttpContext } from '@adonisjs/core/http'
import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy'

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

/**
 * Reads back rows the lifecycle event listener writes. See
 * `app/listeners/audit_listener.ts` for the producer side.
 */
export default class AuditController {
  async list({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    const requested = Number(request.input('limit', DEFAULT_LIMIT)) || DEFAULT_LIMIT
    const limit = Math.min(Math.max(requested, 1), MAX_LIMIT)
    const rows = await TenantAuditLog.query()
      .where('tenant_id', tenant.id)
      .orderBy('created_at', 'desc')
      .limit(limit)
    return response.ok({ tenantId: tenant.id, count: rows.length, rows })
  }
}

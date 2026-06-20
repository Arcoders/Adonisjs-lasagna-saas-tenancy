import TenantAuditLog, { type AuditActorType } from '../models/satellites/tenant_audit_log.js'

export interface LogActionOptions {
  tenantId?: string | null
  actorType?: AuditActorType
  actorId?: string | null
  action: string
  metadata?: Record<string, unknown>
  ipAddress?: string | null
}

export default class AuditLogService {
  async log(options: LogActionOptions): Promise<TenantAuditLog> {
    return TenantAuditLog.create({
      tenantId: options.tenantId ?? null,
      actorType: options.actorType ?? 'system',
      actorId: options.actorId ?? null,
      action: options.action,
      metadata: options.metadata ?? null,
      ipAddress: options.ipAddress ?? null,
    })
  }

  async listForTenant(
    tenantId: string,
    page = 1,
    limit = 50,
    range: { from?: Date; to?: Date } = {}
  ) {
    const q = TenantAuditLog.query().where('tenant_id', tenantId).orderBy('created_at', 'desc')
    if (range.from) q.where('created_at', '>=', range.from)
    if (range.to) q.where('created_at', '<=', range.to)
    const paginator = await q.paginate(page, Math.min(limit, 200))
    return paginator.serialize()
  }

  /**
   * Stream audit rows for export, batch by batch, oldest first. Unlike
   * {@link listForTenant} (capped at 200/page for the REST API), this is
   * uncapped and yields page-sized batches so a tenant with a very deep history
   * never has to be materialized in memory at once. Omit `tenantId` to export
   * every tenant (including `system` rows whose `tenantId` is null). Ordering is
   * `(created_at, id)` ascending for a deterministic, resumable sweep.
   */
  async *exportStream(
    options: { tenantId?: string; from?: Date; to?: Date; batchSize?: number } = {}
  ): AsyncGenerator<TenantAuditLog[]> {
    const batchSize = Math.max(1, options.batchSize ?? 500)
    let page = 1
    for (;;) {
      const q = TenantAuditLog.query().orderBy('created_at', 'asc').orderBy('id', 'asc')
      if (options.tenantId) q.where('tenant_id', options.tenantId)
      if (options.from) q.where('created_at', '>=', options.from)
      if (options.to) q.where('created_at', '<=', options.to)
      const rows = await q.forPage(page, batchSize)
      if (rows.length === 0) break
      yield rows
      if (rows.length < batchSize) break
      page++
    }
  }
}

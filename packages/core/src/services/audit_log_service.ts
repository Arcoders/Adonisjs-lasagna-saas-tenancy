import TenantAuditLog, { type AuditActorType } from '../models/satellites/tenant_audit_log.js'
import AuditLogDestinationRegistry, {
  type AuditLogEntry,
} from './audit_log_destination_registry.js'
import { executeExtension } from './extensions/execute_extension.js'

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/** Per-destination fan-out deadline. Kept short so a slow sink never holds the
 *  audited request. The canonical DB write is already done by the time it runs. */
const DESTINATION_TIMEOUT_MS = 2_000

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
    // The DB row is the source of truth and stays authoritative: it is written
    // first and returned to the caller. Host destinations run afterwards,
    // isolated and time-bounded, so a slow or throwing sink can never fail the
    // audited operation nor change what `log()` returns.
    const row = await TenantAuditLog.create({
      tenantId: options.tenantId ?? null,
      actorType: options.actorType ?? 'system',
      actorId: options.actorId ?? null,
      action: options.action,
      metadata: options.metadata ?? null,
      ipAddress: options.ipAddress ?? null,
    })
    await this.#fanOut(row)
    return row
  }

  /**
   * Fan the persisted row out to every registered destination, isolated
   * (`allSettled`) and bounded (`executeExtension` timeout). No destinations
   * registered → returns immediately, so the default path adds nothing.
   */
  async #fanOut(row: TenantAuditLog): Promise<void> {
    const registry = await this.#destinationRegistry()
    if (!registry || registry.list().length === 0) return

    const entry: AuditLogEntry = {
      id: row.id,
      tenantId: row.tenantId ?? null,
      actorType: row.actorType,
      actorId: row.actorId ?? null,
      action: row.action,
      metadata: row.metadata ?? null,
      ipAddress: row.ipAddress ?? null,
      createdAt: row.createdAt?.toISO() ?? new Date().toISOString(),
    }

    const results = await Promise.allSettled(
      registry.list().map((destination) =>
        executeExtension(() => Promise.resolve(destination.write(entry)), {
          label: `audit:${destination.name}`,
          timeoutMs: DESTINATION_TIMEOUT_MS,
        })
      )
    )
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed > 0) {
      const logger = await lazyLogger()
      logger?.warn(
        { action: row.action, failed, total: results.length },
        'audit.log: some destinations failed (the canonical DB row is unaffected)'
      )
    }
  }

  /** Resolve the host destination registry from the container, best-effort. */
  async #destinationRegistry(): Promise<AuditLogDestinationRegistry | undefined> {
    try {
      const app = (await import('@adonisjs/core/services/app')).default
      return await app.container.make(AuditLogDestinationRegistry)
    } catch {
      return undefined
    }
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

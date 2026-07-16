import Tenant from '../models/tenant.js'
import type {
  EachOptions,
  TenantRepositoryContract,
  TenantModelContract,
  TenantStatus,
} from '@adonisjs-lasagna/saas-tenancy/types'

export default class TenantRepository implements TenantRepositoryContract {
  async findById(id: string, includeDeleted = false): Promise<TenantModelContract | null> {
    const query = Tenant.query().where('id', id)
    if (!includeDeleted) query.whereNull('deleted_at')
    return query.first()
  }

  async findByIdOrFail(id: string, includeDeleted = false): Promise<TenantModelContract> {
    const tenant = await this.findById(id, includeDeleted)
    if (!tenant) throw new Error(`Tenant ${id} not found`)
    return tenant
  }

  async findByDomain(domain: string): Promise<TenantModelContract | null> {
    return Tenant.query().where('custom_domain', domain).whereNull('deleted_at').first()
  }

  async all(
    options: { includeDeleted?: boolean; statuses?: TenantStatus[] } = {}
  ): Promise<TenantModelContract[]> {
    const query = Tenant.query().orderBy('created_at', 'desc')
    if (!options.includeDeleted) query.whereNull('deleted_at')
    if (options.statuses?.length) query.whereIn('status', options.statuses)
    return query
  }

  async whereIn(ids: string[], includeDeleted = false): Promise<TenantModelContract[]> {
    const query = Tenant.query().whereIn('id', ids)
    if (!includeDeleted) query.whereNull('deleted_at')
    return query
  }

  async countByStatus(
    options: { includeDeleted?: boolean } = {}
  ): Promise<Partial<Record<TenantStatus, number>>> {
    // GROUP BY in the database returns at most one row per status, never the
    // full table. The /metrics collector uses this to stay O(1) per scrape.
    const query = Tenant.query().select('status').count('* as total').groupBy('status')
    if (!options.includeDeleted) query.whereNull('deleted_at')
    const rows = await query
    const result: Partial<Record<TenantStatus, number>> = {}
    for (const row of rows) {
      result[row.status as TenantStatus] = Number((row.$extras as { total?: unknown }).total ?? 0)
    }
    return result
  }

  async each(
    callback: (tenant: TenantModelContract) => Promise<void> | void,
    options: EachOptions = {}
  ): Promise<void> {
    const batchSize = Math.max(1, options.batchSize ?? 100)
    // Keyset cursor on the primary key, not OFFSET pagination: a callback
    // that mutates the rows being iterated (suspending tenants while
    // filtering on status, say) would shift an offset window and silently
    // skip rows, while an id cursor stays stable under any mutation.
    let lastId: string | null = null
    while (true) {
      const query = Tenant.query().orderBy('id', 'asc').limit(batchSize)
      if (lastId !== null) query.where('id', '>', lastId)
      if (!options.includeDeleted) query.whereNull('deleted_at')
      if (options.statuses?.length) query.whereIn('status', options.statuses)
      const batch = await query
      for (const tenant of batch) {
        await callback(tenant)
      }
      if (batch.length < batchSize) break
      lastId = batch[batch.length - 1]!.id
    }
  }

  async create(data: {
    name: string
    email: string
    status: TenantStatus
  }): Promise<TenantModelContract> {
    return new Tenant().merge(data).save()
  }
}

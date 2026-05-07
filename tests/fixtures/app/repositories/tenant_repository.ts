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

  async each(
    callback: (tenant: TenantModelContract) => Promise<void> | void,
    options: EachOptions = {}
  ): Promise<void> {
    const batchSize = Math.max(1, options.batchSize ?? 100)
    let page = 1
    while (true) {
      const query = Tenant.query().orderBy('id', 'asc')
      if (!options.includeDeleted) query.whereNull('deleted_at')
      if (options.statuses?.length) query.whereIn('status', options.statuses)
      const result = await query.paginate(page, batchSize)
      for (const tenant of result.all()) {
        await callback(tenant)
      }
      if (!result.hasMorePages) break
      page += 1
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

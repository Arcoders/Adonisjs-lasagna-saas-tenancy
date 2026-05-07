import type {
  EachOptions,
  TenantModelContract,
  TenantRepositoryContract,
  TenantStatus,
  TenantMetadata,
} from '../types/contracts.js'
import { buildTestTenant } from './builders.js'

export class MockTenantRepository<TMeta extends object = TenantMetadata>
  implements TenantRepositoryContract<TMeta>
{
  readonly #tenants = new Map<string, TenantModelContract<TMeta>>()

  constructor(initial?: TenantModelContract<TMeta>[]) {
    if (initial) {
      for (const t of initial) this.#tenants.set(t.id, t)
    }
  }

  add(tenant: TenantModelContract<TMeta>): this {
    this.#tenants.set(tenant.id, tenant)
    return this
  }

  clear(): this {
    this.#tenants.clear()
    return this
  }

  count(): number {
    return this.#tenants.size
  }

  async findById(id: string, includeDeleted = false): Promise<TenantModelContract<TMeta> | null> {
    const tenant = this.#tenants.get(id)
    if (!tenant) return null
    if (!includeDeleted && tenant.isDeleted) return null
    return tenant
  }

  async findByIdOrFail(
    id: string,
    includeDeleted = false
  ): Promise<TenantModelContract<TMeta>> {
    const tenant = await this.findById(id, includeDeleted)
    if (!tenant) throw new Error(`MockTenantRepository: tenant "${id}" not found`)
    return tenant
  }

  async findByDomain(domain: string): Promise<TenantModelContract<TMeta> | null> {
    for (const t of this.#tenants.values()) {
      if (!t.isDeleted && t.customDomain === domain) return t
    }
    return null
  }

  async all(options: { includeDeleted?: boolean; statuses?: TenantStatus[] } = {}): Promise<
    TenantModelContract<TMeta>[]
  > {
    const { includeDeleted = false, statuses } = options
    return [...this.#tenants.values()].filter((t) => {
      if (!includeDeleted && t.isDeleted) return false
      if (statuses && !statuses.includes(t.status)) return false
      return true
    })
  }

  async whereIn(
    ids: string[],
    includeDeleted = false
  ): Promise<TenantModelContract<TMeta>[]> {
    const idSet = new Set(ids)
    return [...this.#tenants.values()].filter((t) => {
      if (!idSet.has(t.id)) return false
      if (!includeDeleted && t.isDeleted) return false
      return true
    })
  }

  async each(
    callback: (tenant: TenantModelContract<TMeta>) => Promise<void> | void,
    options: EachOptions = {}
  ): Promise<void> {
    const matches = await this.all({
      includeDeleted: options.includeDeleted,
      statuses: options.statuses,
    })
    for (const tenant of matches) {
      await callback(tenant)
    }
  }

  async create(data: {
    name: string
    email: string
    status: TenantStatus
  }): Promise<TenantModelContract<TMeta>> {
    const tenant = buildTestTenant<TMeta>({
      name: data.name,
      email: data.email,
      status: data.status,
    })
    this.#tenants.set(tenant.id, tenant)
    return tenant
  }
}

export function mockTenantRepository<TMeta extends object = TenantMetadata>(
  initial?: TenantModelContract<TMeta>[]
): MockTenantRepository<TMeta> {
  return new MockTenantRepository<TMeta>(initial)
}

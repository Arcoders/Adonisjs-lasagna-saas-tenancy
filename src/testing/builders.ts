import { randomUUID } from 'node:crypto'
import { DateTime } from 'luxon'
import { getConfig } from '../config.js'
import type {
  TenantModelContract,
  TenantStatus,
  TenantMetadata,
} from '../types/contracts.js'

export interface BuildTestTenantOverrides<TMeta extends object = TenantMetadata> {
  id?: string
  name?: string
  email?: string
  status?: TenantStatus
  customDomain?: string | null
  createdAt?: DateTime
  deletedAt?: DateTime | null
  metadata?: TMeta
}

export function buildTestTenant<TMeta extends object = TenantMetadata>(
  overrides: BuildTestTenantOverrides<TMeta> = {}
): TenantModelContract<TMeta> {
  const id = overrides.id ?? randomUUID()
  const status: TenantStatus = overrides.status ?? 'active'
  const tenant: any = {
    id,
    name: overrides.name ?? `Test Tenant ${id.slice(0, 8)}`,
    email: overrides.email ?? `test-${id.slice(0, 8)}@fixture.test`,
    status,
    customDomain: overrides.customDomain ?? null,
    createdAt: overrides.createdAt ?? DateTime.now(),
    deletedAt: overrides.deletedAt ?? null,
    metadata: overrides.metadata,
    get schemaName() {
      return `${getConfig().tenantSchemaPrefix}${this.id.replace(/-/g, '_')}`
    },
    get isActive() {
      return this.status === 'active'
    },
    get isSuspended() {
      return this.status === 'suspended'
    },
    get isProvisioning() {
      return this.status === 'provisioning'
    },
    get isFailed() {
      return this.status === 'failed'
    },
    get isDeleted() {
      return this.deletedAt !== null
    },
    async suspend() {
      this.status = 'suspended'
    },
    async activate() {
      this.status = 'active'
    },
    async save() {
      return tenant
    },
  }
  return tenant as TenantModelContract<TMeta>
}

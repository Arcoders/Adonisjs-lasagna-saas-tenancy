import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import type { TenantStatus } from '@adonisjs-lasagna/saas-tenancy/types'

export interface TestTenant {
  id: string
  name: string
  email: string
  status: TenantStatus
}

export async function createTestTenant(
  overrides: Partial<{ name: string; email: string; status: TenantStatus }> = {}
): Promise<TestTenant> {
  const id = randomUUID()
  const name = overrides.name ?? `Test Tenant ${id.slice(0, 8)}`
  const email = overrides.email ?? `test-${id.slice(0, 8)}@fixture.test`
  const status: TenantStatus = overrides.status ?? 'active'

  await db.connection('backoffice').table('tenants').insert({
    id,
    name,
    email,
    status,
    created_at: new Date(),
    updated_at: new Date(),
    deleted_at: null,
    custom_domain: null,
  })

  return { id, name, email, status }
}

export async function destroyTestTenant(tenantId: string): Promise<void> {
  await db.connection('backoffice').query().from('tenants').where('id', tenantId).delete()
}

export async function updateTenantStatus(tenantId: string, status: TenantStatus): Promise<void> {
  await db
    .connection('backoffice')
    .query()
    .from('tenants')
    .where('id', tenantId)
    .update({ status, updated_at: new Date() })
}

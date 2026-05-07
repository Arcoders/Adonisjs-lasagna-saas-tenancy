import db from '@adonisjs/lucid/services/db'
import { randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import type { TenantStatus } from '../types/contracts.js'

export interface TestTenantRow {
  id: string
  name: string
  email: string
  status: TenantStatus
  customDomain: string | null
}

export interface CreateTestTenantOverrides {
  id?: string
  name?: string
  email?: string
  status?: TenantStatus
  customDomain?: string | null
}

export async function createTestTenant(
  overrides: CreateTestTenantOverrides = {}
): Promise<TestTenantRow> {
  const id = overrides.id ?? randomUUID()
  const name = overrides.name ?? `Test Tenant ${id.slice(0, 8)}`
  const email = overrides.email ?? `test-${id.slice(0, 8)}@fixture.test`
  const status: TenantStatus = overrides.status ?? 'active'
  const customDomain = overrides.customDomain ?? null

  await db
    .connection(getConfig().backofficeConnectionName)
    .table('tenants')
    .insert({
      id,
      name,
      email,
      status,
      custom_domain: customDomain,
      created_at: new Date(),
      updated_at: new Date(),
      deleted_at: null,
    })

  return { id, name, email, status, customDomain }
}

export async function destroyTestTenant(tenantId: string): Promise<void> {
  await db
    .connection(getConfig().backofficeConnectionName)
    .query()
    .from('tenants')
    .where('id', tenantId)
    .delete()
}

export interface CleanupFilter {
  emailLike?: string
  namePrefix?: string
}

export async function cleanupTenants(filter: CleanupFilter = {}): Promise<number> {
  const query = db
    .connection(getConfig().backofficeConnectionName)
    .query()
    .from('tenants')

  if (filter.emailLike) query.where('email', 'like', filter.emailLike)
  if (filter.namePrefix) query.where('name', 'like', `${filter.namePrefix}%`)

  const result = await query.delete()
  return Array.isArray(result) ? Number(result[0] ?? 0) : Number(result ?? 0)
}

export async function updateTestTenantStatus(
  tenantId: string,
  status: TenantStatus
): Promise<void> {
  await db
    .connection(getConfig().backofficeConnectionName)
    .query()
    .from('tenants')
    .where('id', tenantId)
    .update({ status, updated_at: new Date() })
}

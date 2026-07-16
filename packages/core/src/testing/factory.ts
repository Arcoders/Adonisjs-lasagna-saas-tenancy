import { randomUUID } from 'node:crypto'
import { getConfig } from '../config.js'
import type { TenantStatus } from '../types/contracts.js'

/**
 * Lazily resolve the Lucid `db` service. Importing it at module top-level fires
 * its `await app.booted(...)`, which throws outside an Ignitor. That would make
 * the whole `/testing` barrel unloadable in a hermetic unit test (a satellite
 * author importing one helper would crash on an unrelated one). The DB is only
 * touched at call time, which is always inside a booted app, so deferring the
 * import is free.
 */
async function getDb() {
  return (await import('@adonisjs/lucid/services/db')).default
}

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

  const db = await getDb()
  // Pin the write to the backoffice schema explicitly (AD-08), so this shipped test
  // helper doesn't depend on the backoffice connection's search_path being set.
  await db
    .connection(getConfig().backofficeConnectionName)
    .table('tenants')
    .withSchema(getConfig().backofficeSchemaName)
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
  const db = await getDb()
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
  const db = await getDb()
  const query = db.connection(getConfig().backofficeConnectionName).query().from('tenants')

  if (filter.emailLike) query.where('email', 'like', filter.emailLike)
  if (filter.namePrefix) query.where('name', 'like', `${filter.namePrefix}%`)

  const result = await query.delete()
  return Array.isArray(result) ? Number(result[0] ?? 0) : Number(result ?? 0)
}

export async function updateTestTenantStatus(
  tenantId: string,
  status: TenantStatus
): Promise<void> {
  const db = await getDb()
  await db
    .connection(getConfig().backofficeConnectionName)
    .query()
    .from('tenants')
    .where('id', tenantId)
    .update({ status, updated_at: new Date() })
}

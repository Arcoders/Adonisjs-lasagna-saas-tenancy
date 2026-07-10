import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import {
  TenantUpdated,
  TenantBackedUp,
  TenantRestored,
  TenantCloned,
} from '@adonisjs-lasagna/saas-tenancy/events'
import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import Tenant from '#app/models/backoffice/tenant'
import { ADMIN_HEADERS, createInstalledTenant, dropAllTenants, runAce } from './_helpers.js'

async function auditActions(tenantId: string): Promise<string[]> {
  const rows = await TenantAuditLog.query()
    .where('tenant_id', tenantId)
    .orderBy('created_at', 'desc')
  return rows.map((r) => r.action)
}

/**
 * Asserts that the listeners wired in `start/routes.ts` emit an audit row for
 * each of the 11 lifecycle events the package defines.
 *
 * Note: TenantBackedUp / TenantRestored / TenantCloned are dispatched by the
 * queue jobs (`BackupTenant`, `RestoreTenant`, `CloneTenant`), NOT by the
 * synchronous CLI commands. The CLI commands run the underlying service but
 * don't emit. This test verifies the listener wiring with synthetic dispatch
 * — full command-driven flow lives in `backups_real.spec.ts`.
 */
test.group('e2e — 11 lifecycle events surface in the audit log', (group) => {
  group.setup(async () => {
    await dropAllTenants()
  })
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('TenantCreated, TenantProvisioned, TenantActivated fire on inline install', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const actions = await auditActions(id)
    assert.include(actions, 'tenant.created')
    assert.include(actions, 'tenant.provisioned')
    assert.include(actions, 'tenant.activated')
  })

  test('TenantMigrated fires from the tenant:migrate command', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    const code = await runAce('tenant:migrate', ['--tenant', id])
    assert.equal(code, 0)
    const actions = await auditActions(id)
    assert.include(actions, 'tenant.migrated')

    const row = await TenantAuditLog.query()
      .where('tenant_id', id)
      .where('action', 'tenant.migrated')
      .firstOrFail()
    assert.equal((row.metadata as any)?.direction, 'up')
  })

  test('TenantSuspended fires from the admin suspend endpoint', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    await client.post(`/admin/tenants/${id}/suspend`).headers(ADMIN_HEADERS)
    const actions = await auditActions(id)
    assert.include(actions, 'tenant.suspended')
  })

  test('TenantUpdated fires when manually dispatched', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    const tenant = await Tenant.findOrFail(id)
    const previousName = tenant.name
    tenant.name = `Renamed ${id.slice(0, 8)}`
    await tenant.save()
    await TenantUpdated.dispatch(tenant as any, { name: { from: previousName, to: tenant.name } })
    const actions = await auditActions(id)
    assert.include(actions, 'tenant.updated')

    const row = await TenantAuditLog.query()
      .where('tenant_id', id)
      .where('action', 'tenant.updated')
      .firstOrFail()
    assert.match((row.metadata as any)?.name, /^Renamed/)
  })

  test('TenantDeleted fires from the admin destroy endpoint', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    await client
      .post(`/admin/tenants/${id}/destroy`)
      .headers(ADMIN_HEADERS)
      .json({ keepSchema: true })
    const actions = await auditActions(id)
    assert.include(actions, 'tenant.deleted')
  })

  test('TenantQuotaExceeded fires when the free-plan apiCallsPerDay limit is hit', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { plan: 'free' })

    // Reset the rolling counter (48h TTL in Redis) so prior runs don't bleed in.
    const tenantModel = await Tenant.findOrFail(id)
    const quotaSvc = await app.container.make(QuotaService)
    await quotaSvc.reset(tenantModel, 'apiCallsPerDay')

    // Free plan = 50/day; 60 attempts clears the cliff at #51. Statuses
    // captured so a failure shows what came back instead of "false to be true".
    let saw429 = false
    const statuses: number[] = []
    for (let i = 0; i < 60; i++) {
      const r = await client
        .post('/demo/notes')
        .header('x-tenant-id', id)
        .json({ title: `n${i}` })
      statuses.push(r.status())
      if (r.status() === 429) {
        saw429 = true
        break
      }
    }
    assert.isTrue(
      saw429,
      `expected at least one 429 in 60 attempts; statuses seen: ${JSON.stringify(statuses)}`
    )

    let actions: string[] = []
    for (let i = 0; i < 10; i++) {
      actions = await auditActions(id)
      if (actions.includes('tenant.quota_exceeded')) break
      await new Promise((r) => setTimeout(r, 100))
    }
    assert.include(actions, 'tenant.quota_exceeded')

    const row = await TenantAuditLog.query()
      .where('tenant_id', id)
      .where('action', 'tenant.quota_exceeded')
      .firstOrFail()
    assert.equal((row.metadata as any)?.quota, 'apiCallsPerDay')
    assert.equal((row.metadata as any)?.limit, 50)
  })

  test('TenantBackedUp listener writes the BackupMetadata payload to audit', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const tenant = await Tenant.findOrFail(id)
    await TenantBackedUp.dispatch(
      tenant as any,
      {
        file: 'tenant_synthetic.dump',
        size: 4096,
        timestamp: new Date().toISOString(),
        tenantId: tenant.id,
        schema: tenant.schemaName,
      } as any
    )

    const row = await TenantAuditLog.query()
      .where('tenant_id', id)
      .where('action', 'tenant.backed_up')
      .orderBy('created_at', 'desc')
      .firstOrFail()
    assert.equal((row.metadata as any)?.file, 'tenant_synthetic.dump')
    assert.equal((row.metadata as any)?.sizeBytes, 4096)
  })

  test('TenantRestored listener writes the file name to audit', async ({ client, assert }) => {
    const { id } = await createInstalledTenant(client)
    const tenant = await Tenant.findOrFail(id)
    await TenantRestored.dispatch(tenant as any, 'tenant_synthetic.dump')

    const row = await TenantAuditLog.query()
      .where('tenant_id', id)
      .where('action', 'tenant.restored')
      .orderBy('created_at', 'desc')
      .firstOrFail()
    assert.equal((row.metadata as any)?.fileName, 'tenant_synthetic.dump')
  })

  test('TenantCloned listener writes both source/destination to audit', async ({
    client,
    assert,
  }) => {
    const source = await createInstalledTenant(client, { name: 'CloneSrc' })
    const dest = await createInstalledTenant(client, { name: 'CloneDst' })
    const sourceModel = await Tenant.findOrFail(source.id)
    const destModel = await Tenant.findOrFail(dest.id)

    await TenantCloned.dispatch(
      sourceModel as any,
      destModel as any,
      {
        tablesCopied: 3,
        rowsCopied: 42,
        destination: destModel as any,
      } as any
    )

    const row = await TenantAuditLog.query()
      .where('tenant_id', dest.id)
      .where('action', 'tenant.cloned')
      .orderBy('created_at', 'desc')
      .firstOrFail()
    assert.equal((row.metadata as any)?.sourceId, source.id)
    assert.equal((row.metadata as any)?.tablesCopied, 3)
    assert.equal((row.metadata as any)?.rowsCopied, 42)
  })
})

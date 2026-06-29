import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { IsolationDriverRegistry, SchemaPgDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

/**
 * I3 — Satellite migration partial-failure recovery.
 *
 * A satellite ships a batch of migrations and one fails mid-batch. This proves
 * the failure is surfaced and recoverable, not silent or wedged:
 *  - schema_pg_driver.migrate() re-throws the runner error (driver.ts re-throws
 *    runner.error rather than swallowing it);
 *  - the migration that ran before the failure committed (Lucid wraps each
 *    migration in its own transaction);
 *  - the failing migration left NO table AND NO ledger row, so a corrected
 *    re-run re-attempts only it and completes, leaving no inconsistent state.
 *
 * The fixture migrations live in database/migrations/tenant_recovery_fixture.
 * The second one throws until `globalThis.__satelliteRecoveryFixApplied` is set,
 * which the spec flips to model the operator correcting the cause and re-running.
 */
async function findTenantModel(id: string): Promise<TenantModelContract> {
  const Tenant = (await import('../../../fixtures/app/models/tenant.js')).default
  const t = await Tenant.find(id)
  if (!t) throw new Error(`tenant ${id} not found`)
  return t as unknown as TenantModelContract
}

async function tableExists(schema: string, table: string): Promise<boolean> {
  const result = await db.rawQuery(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [schema, table]
  )
  return Array.isArray(result.rows) ? result.rows.length > 0 : (result as any).length > 0
}

/** Names recorded in the tenant's migration ledger (Lucid's adonis_schema table). */
async function ledgerNames(connectionName: string): Promise<string[]> {
  const rows = await db.connection(connectionName).from('adonis_schema').select('name')
  return rows.map((r: any) => String(r.name))
}

const RECOVERY_TEMPLATE = 'recovery_template'

test.group('Satellite migration partial-failure recovery (I3)', (group) => {
  let driver: SchemaPgDriver

  group.setup(async () => {
    const reg = await app.container.make(IsolationDriverRegistry)
    if (reg.active().name !== 'schema-pg') {
      throw new Error(`I3 requires the schema-pg driver (got '${reg.active().name}')`)
    }

    // A dedicated template connection that points migrations at the recovery
    // fixture dir, so we exercise schema_pg_driver.migrate() against a known
    // failing batch without touching the shared `tenant` connection's config.
    if (!db.manager.has(RECOVERY_TEMPLATE)) {
      const base = db.manager.get('tenant')!.config
      db.manager.add(RECOVERY_TEMPLATE, {
        ...base,
        migrations: {
          paths: ['./database/migrations/tenant_recovery_fixture'],
          naturalSort: true,
        },
      } as any)
    }
    driver = new SchemaPgDriver({ templateConnectionName: RECOVERY_TEMPLATE })
  })

  group.each.teardown(() => {
    delete (globalThis as any).__satelliteRecoveryFixApplied
  })

  test('a failing migration mid-batch is surfaced, leaves no trace, and re-runs clean', async ({
    assert,
  }) => {
    const row = await createTestTenant({ status: 'provisioning' })
    const tenant = await findTenantModel(row.id)
    const schema = `tenant_${row.id}`
    const connectionName = driver.connectionName(row.id)

    await driver.provision(tenant)

    try {
      // ----- 1. First run: the second migration throws -----
      delete (globalThis as any).__satelliteRecoveryFixApplied
      await assert.rejects(() => driver.migrate(tenant, { direction: 'up' }), /simulated bad DDL/)

      // The first migration committed; the failing one left no table.
      assert.isTrue(
        await tableExists(schema, 'recovery_step_one'),
        'the migration before the failure must have committed'
      )
      assert.isFalse(
        await tableExists(schema, 'recovery_step_two'),
        'the failing migration must not have created its table'
      )

      // And no ledger row for the failure, so the re-run actually re-attempts it.
      const afterFailure = await ledgerNames(connectionName)
      assert.isTrue(
        afterFailure.some((n) => n.includes('recovery_step_one')),
        'the committed migration must be recorded in the ledger'
      )
      assert.isFalse(
        afterFailure.some((n) => n.includes('recovery_step_two')),
        'the failed migration must NOT be recorded in the ledger'
      )

      // ----- 2. Corrected re-run: the cause is fixed, the batch completes -----
      ;(globalThis as any).__satelliteRecoveryFixApplied = true
      await assert.doesNotReject(() => driver.migrate(tenant, { direction: 'up' }))

      assert.isTrue(
        await tableExists(schema, 'recovery_step_two'),
        'the corrected re-run must create the previously-failing table'
      )
      const afterRecovery = await ledgerNames(connectionName)
      assert.isTrue(
        afterRecovery.some((n) => n.includes('recovery_step_two')),
        'the recovered migration must now be recorded in the ledger'
      )
    } finally {
      await driver.destroy(tenant).catch(() => {})
      await destroyTestTenant(row.id).catch(() => {})
    }
  })
})

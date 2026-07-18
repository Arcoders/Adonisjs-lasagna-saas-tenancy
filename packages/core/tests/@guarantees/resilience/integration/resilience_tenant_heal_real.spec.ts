import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { healTenant, getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Real-PG proof of the keystone remediation primitive. It exercises the
 * non-destructive guarantees the whole doctor `--fix` / `tenant:heal` /
 * `migrateOnProvision` surface relies on: provision-if-missing, migrate to head,
 * idempotency, and — critically — that heal NEVER drops or resets a schema.
 */
test.group('healTenant — real-state E2E (keystone)', () => {
  const central = () => db.connection(getConfig().centralConnectionName)

  async function schemaExists(schema: string): Promise<boolean> {
    const rows = await central().rawQuery(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`,
      [schema]
    )
    return (rows.rows ?? rows ?? []).length > 0
  }
  async function tableExists(schema: string, table: string): Promise<boolean> {
    const rows = await central().rawQuery(
      `SELECT 1 FROM information_schema.tables WHERE table_schema = ? AND table_name = ?`,
      [schema, table]
    )
    return (rows.rows ?? rows ?? []).length > 0
  }

  test('heals a missing schema: provisions + migrates, idempotent, and never destroys', async ({
    assert,
  }) => {
    const cfg = getConfig()
    const tenant = await createTestTenant({ status: 'active', name: 'HealMe' })
    const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`

    // Spy: heal must NEVER call destroy or reset (the non-destructive guarantee).
    const driver = await getActiveDriver()
    let destroyCalls = 0
    let resetCalls = 0
    const origDestroy = (driver as any).destroy.bind(driver)
    const origReset = (driver as any).reset.bind(driver)
    ;(driver as any).destroy = async (...a: any[]) => {
      destroyCalls++
      return origDestroy(...a)
    }
    ;(driver as any).reset = async (...a: any[]) => {
      resetCalls++
      return origReset(...a)
    }

    try {
      assert.isFalse(await schemaExists(schema), 'precondition: schema absent')

      const first = await healTenant({ id: tenant.id } as TenantModelContract, {
        fireHooks: true,
        audit: false,
      })
      assert.isTrue(first.provisioned, 'first heal provisions the missing schema')
      assert.isAbove(first.migrated, 0, 'first heal applies the pending migration(s)')
      assert.isTrue(await schemaExists(schema), 'schema exists after heal')
      assert.isTrue(await tableExists(schema, 'adonis_schema'), 'adonis_schema ledger present')
      assert.isTrue(await tableExists(schema, 'notes'), 'per-tenant migration applied')

      const second = await healTenant({ id: tenant.id } as TenantModelContract, {
        fireHooks: true,
        audit: false,
      })
      assert.isFalse(second.provisioned, 'second heal provisions nothing')
      assert.equal(second.migrated, 0, 'second heal applies no migrations (idempotent)')
      assert.isTrue(second.already, 'second heal is a full no-op')

      assert.equal(destroyCalls, 0, 'heal must never call driver.destroy')
      assert.equal(resetCalls, 0, 'heal must never call driver.reset')
    } finally {
      ;(driver as any).destroy = origDestroy
      ;(driver as any).reset = origReset
      await central().rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('refuses to heal a soft-deleted tenant (TOCTOU guard)', async ({ assert }) => {
    const tenant = await createTestTenant({ status: 'active', name: 'DeletedHeal' })
    // Stamp it soft-deleted so the fresh re-read inside heal sees isDeleted.
    await db
      .connection('backoffice')
      .query()
      .from('tenants')
      .where('id', tenant.id)
      .update({ deleted_at: new Date(), status: 'deleted' })

    try {
      await assert.rejects(
        () => healTenant({ id: tenant.id } as TenantModelContract, { audit: false }),
        /soft-deleted/
      )
    } finally {
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })

  test('recovers a failed tenant to active on a successful heal', async ({ assert }) => {
    const cfg = getConfig()
    const tenant = await createTestTenant({ status: 'failed', name: 'RecoverMe' })
    const schema = `${cfg.tenantSchemaPrefix}${tenant.id}`
    try {
      const result = await healTenant({ id: tenant.id } as TenantModelContract, {
        fireHooks: true,
        audit: false,
      })
      assert.isTrue(result.provisioned)
      const repoRow = await db
        .connection('backoffice')
        .query()
        .from('tenants')
        .where('id', tenant.id)
        .first()
      assert.equal(repoRow.status, 'active', 'a healed failed tenant returns to active')
    } finally {
      await central().rawQuery(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      await destroyTestTenant(tenant.id).catch(() => {})
    }
  })
})

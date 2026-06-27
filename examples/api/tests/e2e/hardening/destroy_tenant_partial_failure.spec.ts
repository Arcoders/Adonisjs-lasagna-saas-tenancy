import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import { IsolationDriverRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants, runAce } from '../_helpers.js'

/**
 * WS-2 / tenant-lifecycle-partial-failure — destroy chaos (e2e).
 *
 * `tenant:destroy` soft-deletes the tenant THEN drops its schema. If the drop
 * fails after the soft-delete, the tenant is already unreachable but its schema
 * is ORPHANED. Before the fix this surfaced as a bare error with no recovery
 * path short of the full retention window. The fix: the command reports the
 * orphan clearly and exits 1, and `tenant:purge-expired --include-orphans`
 * reclaims it immediately (a soft-deleted tenant whose schema still exists is
 * the pending-purge marker).
 *
 * We force the drop to fail by swapping the active isolation driver for a proxy
 * that throws only on `destroy()`, then restore the real driver before recovery.
 */
async function schemaExists(id: string): Promise<boolean> {
  const r = await db
    .connection('public')
    .rawQuery(
      `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ?) AS present`,
      [`tenant_${id}`]
    )
  return Boolean(r.rows[0].present)
}

test.group('hardening — tenant:destroy partial failure leaves a recoverable orphan', (group) => {
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('a schema-drop failure soft-deletes the tenant; --include-orphans reclaims it', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client, { migrate: false })
    const registry = await app.container.make(IsolationDriverRegistry)
    const real = registry.active()

    // Delegate everything to the real driver but throw on destroy().
    const failing = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'name') return '__failing_destroy'
        if (prop === 'destroy') {
          return async () => {
            throw new Error('chaos: schema drop failed')
          }
        }
        const v = Reflect.get(target, prop, recv)
        return typeof v === 'function' ? v.bind(target) : v
      },
    })

    registry.register(failing as any, { activate: true })
    try {
      const code = await runAce('tenant:destroy', [id, '--force'])
      assert.equal(code, 1, 'destroy exits 1 when the schema drop fails')

      const t = await Tenant.findOrFail(id)
      assert.isNotNull(t.deletedAt, 'tenant is soft-deleted (unreachable) despite the drop failure')
      assert.isTrue(await schemaExists(id), 'the schema is orphaned (still present)')
    } finally {
      registry.setActive(real.name) // restore the real driver for recovery
    }

    // Recovery WITHOUT waiting out retention: --include-orphans drops it now.
    const purgeCode = await runAce('tenant:purge-expired', ['--include-orphans', '--force'])
    assert.equal(purgeCode, 0, 'purge --include-orphans exits 0')
    assert.isFalse(await schemaExists(id), 'orphan schema reclaimed by --include-orphans')
  })
})

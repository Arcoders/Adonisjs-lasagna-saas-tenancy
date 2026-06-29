import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants, runAce } from '../_helpers.js'

/**
 * WS-2 / tenant-lifecycle-partial-failure — reprovision recovery (e2e).
 *
 * A tenant stuck in `failed` (a provisioning job threw) was a dead end: the
 * install job had run and the status floor keeps serving it a 503. `tenant:activate`
 * only flips status — it does NOT re-create the schema. `tenant:reprovision`
 * re-runs the idempotent provision and lands the tenant `active` with a real schema.
 *
 * RED (pre-fix): the command did not exist; a failed tenant was unrecoverable.
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

test.group('hardening — tenant:reprovision recovers a failed tenant', (group) => {
  group.teardown(async () => {
    await dropAllTenants()
  })

  test('a failed tenant is reprovisioned back to active with a live schema', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)

    // Simulate a provisioning failure: flip the status to `failed`.
    const tenant = await Tenant.findOrFail(id)
    tenant.status = 'failed'
    await tenant.save()

    const code = await runAce('tenant:reprovision', [id, '--force'])
    assert.equal(code, 0, 'tenant:reprovision should exit 0')

    assert.equal(
      (await Tenant.findOrFail(id)).status,
      'active',
      'tenant is active after reprovision'
    )
    assert.isTrue(await schemaExists(id), 'the tenant schema exists after reprovision')
  })

  test('reprovision is a no-op on an already-active tenant (exit 0, stays active)', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)
    const code = await runAce('tenant:reprovision', [id, '--force'])
    assert.equal(code, 0)
    assert.equal((await Tenant.findOrFail(id)).status, 'active')
  })
})

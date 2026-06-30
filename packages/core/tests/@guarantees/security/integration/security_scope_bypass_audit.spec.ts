import { test } from '@japa/runner'
import { unscoped } from '@adonisjs-lasagna/saas-tenancy'
import { TenantAuditLog } from '@adonisjs-lasagna/saas-tenancy/models/satellites'

/**
 * WS-6: a real cross-tenant bypass leaves an attributed audit trail. Driving the
 * public `unscoped()` seam against the booted app must write exactly one
 * `scope:bypass` row carrying the caller's reason, and a NESTED bypass must not
 * double-emit (the re-entrancy guard). Each test uses a unique reason so it is
 * isolated from any other bypass rows the run produces.
 */
async function reasonsLogged(): Promise<string[]> {
  const rows = await TenantAuditLog.query().where('action', 'scope:bypass')
  return rows
    .map((r) => {
      const meta = (typeof r.metadata === 'string' ? JSON.parse(r.metadata) : r.metadata) ?? {}
      return (meta as { reason?: unknown }).reason
    })
    .filter((reason): reason is string => typeof reason === 'string')
}

test.group('scope-bypass audit — real emission (integration)', () => {
  test('an outermost unscoped({ reason }) writes one attributed scope:bypass row', async ({
    assert,
  }) => {
    const reason = `ws6-outer-${Date.now()}`
    await unscoped(async () => 'ok', { reason })

    const logged = await reasonsLogged()
    assert.equal(logged.filter((r) => r === reason).length, 1, 'exactly one attributed bypass row')
  })

  test('a nested unscoped does not double-emit (re-entrancy guard)', async ({ assert }) => {
    const outer = `ws6-outer2-${Date.now()}`
    const nested = `ws6-nested-${Date.now()}`

    await unscoped(
      async () => {
        await unscoped(async () => 'inner', { reason: nested })
        return 'outer'
      },
      { reason: outer }
    )

    const logged = await reasonsLogged()
    assert.equal(logged.filter((r) => r === outer).length, 1, 'the outer bypass emits once')
    assert.equal(logged.filter((r) => r === nested).length, 0, 'the nested bypass does not emit')
  })
})

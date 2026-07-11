import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import ace from '@adonisjs/core/services/ace'
import { createInstalledTenant, dropAllTenants, runAce } from '../_helpers.js'

/**
 * Uninstall runs a read-only checklist, then reinstall is clean.
 *
 * Lasagna's uninstall is deliberately READ-ONLY: `tenant:satellite:remove` prints
 * the exact steps (and the precise backoffice migration files) to roll back, but
 * never edits adonisrc.ts or drops tables, because auto-dropping shared backoffice
 * data is a footgun. This spec proves the two halves of that contract on the demo's
 * REAL migrations (the integration test-kit seeds backoffice tables with raw DDL,
 * so a real down()/up() story has to live here):
 *
 *  1. the remove command names the satellite's published backoffice migration and
 *     drops nothing (read-only), and
 *  2. reinstalling (re-running the idempotent `backoffice:setup`) preserves the
 *     satellite's table and its data, so recovery never wipes a tenant's rows.
 *
 * Note on scope: we do NOT drive `migration:rollback --connection backoffice`
 * here. The demo's backoffice migrations are applied as a single batch and Lucid
 * rolls back by batch, so one rollback would drop EVERY backoffice table
 * (including `tenants`) on the shared e2e database and corrupt sibling specs. The
 * operator-facing rollback is the manual step the remove command documents; the
 * `migration:run` idempotency (re-applying after a rollback) is proven by
 * backoffice_setup_rerun.spec.ts and extended to the data layer below.
 */
async function regclass(qualified: string): Promise<string | null> {
  const r = await db.rawQuery('SELECT to_regclass(?) AS reg', [qualified])
  return r.rows[0].reg
}

test.group('e2e — satellite uninstall (read-only) + reinstall (E1)', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('tenant:satellite:remove names the published backoffice migration and drops nothing', async ({
    assert,
  }) => {
    // The SSO satellite is a packaged satellite that published a real backoffice
    // migration into the demo (database/migrations/backoffice/*tenant_sso_configs*).
    const before = await regclass('backoffice.tenant_sso_configs')
    assert.isNotNull(before, 'precondition: the sso satellite table exists before removal')

    let text = ''
    let exitCode = 0
    const ui: any = (ace as any).ui
    try {
      ui?.switchMode?.('raw')
      const cmd: any = await ace.exec('tenant:satellite:remove', ['@adonisjs-lasagna/sso'])
      exitCode = cmd?.exitCode ?? 0
      const logs: Array<{ message: string }> =
        cmd?.logger?.getLogs?.() ?? ui?.logger?.getLogs?.() ?? []
      text = logs.map((l) => l.message).join('\n')
    } finally {
      ui?.switchMode?.('normal')
    }

    assert.equal(exitCode, 0, 'removing a discoverable satellite exits 0')
    assert.include(
      text,
      'create_tenant_sso_configs_table',
      'the checklist must name the exact backoffice migration to roll back'
    )
    assert.match(
      text,
      /backoffice schema/i,
      'the checklist must explain the rollback is the complete (backoffice-only) cleanup'
    )

    // Read-only contract: the command must NOT have dropped the table.
    const after = await regclass('backoffice.tenant_sso_configs')
    assert.isNotNull(after, 'tenant:satellite:remove must not drop any table (it is read-only)')
  })

  test('reinstall via backoffice:setup is idempotent and preserves satellite data', async ({
    client,
    assert,
  }) => {
    const { id } = await createInstalledTenant(client)

    // Write a satellite row through HTTP and confirm it reads back.
    const post = await client
      .post('/demo/feature-flags')
      .header('x-tenant-id', id)
      .json({ flag: 'reinstall_canary', enabled: true })
    post.assertStatus(201)

    // "Reinstall": re-run the idempotent backoffice setup. It must not error, not
    // duplicate migrations, and not wipe existing satellite data.
    assert.equal(await runAce('backoffice:setup'), 0, 'backoffice:setup re-run must exit 0')

    const list = await client.get('/demo/feature-flags').header('x-tenant-id', id)
    list.assertStatus(200)
    const flags = list.body().flags.map((f: any) => f.flag)
    assert.include(flags, 'reinstall_canary', 'a re-run of backoffice:setup must not wipe rows')

    // The satellite surface is still writable after the reinstall.
    const post2 = await client
      .post('/demo/feature-flags')
      .header('x-tenant-id', id)
      .json({ flag: 'post_reinstall', enabled: false })
    post2.assertStatus(201)
  })
})

import { test } from '@japa/runner'
import Tenant from '#app/models/backoffice/tenant'
import { createInstalledTenant, dropAllTenants, runAce } from './_helpers.js'

/**
 * CLI failure robustness. The package's command unit specs are metadata-only
 * (CLAUDE.md), so execution-under-failure is proven here against the real app.
 *
 * The headline contract is `--continue-on-error`: a bulk per-tenant command must
 * either stop at the first failure (default) or walk past it and still process
 * every healthy tenant, always surfacing the failure as a non-zero exit. We
 * exercise it through `tenant:seed`, which runs `db:seed` (the demo's
 * notes_seeder) against each tenant connection — a real, observable side effect.
 * A tenant provisioned but NOT migrated has no `notes` table, so its seed fails
 * deterministically while its healthy siblings succeed.
 *
 * The restore-from-corruption consistency gap is covered by
 * backups_corruption.spec.ts; backup artifact cleanup needs pg_dump and lives
 * with the backup e2e.
 */
test.group('e2e — CLI failure robustness (tenant:seed --continue-on-error)', (group) => {
  group.each.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  async function notesCount(id: string): Promise<number> {
    const tenant = await Tenant.findOrFail(id)
    const r = await tenant.getConnection().rawQuery('SELECT count(*)::int AS c FROM notes')
    return r.rows[0].c as number
  }

  test('healthy tenants only: tenant:seed exits 0 and seeds every tenant', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client) // migrated → notes exists
    const b = await createInstalledTenant(client)

    assert.equal(await runAce('tenant:seed'), 0, 'all-healthy seed exits 0')
    assert.equal(await notesCount(a.id), 2, 'tenant A was seeded')
    assert.equal(await notesCount(b.id), 2, 'tenant B was seeded')
  })

  test('--continue-on-error walks past a broken tenant and still seeds the healthy ones', async ({
    client,
    assert,
  }) => {
    const healthyA = await createInstalledTenant(client)
    // Provisioned (active) but never migrated: no `notes` table → its seed fails.
    const broken = await createInstalledTenant(client, { migrate: false })
    const healthyC = await createInstalledTenant(client)

    const code = await runAce('tenant:seed', ['--continue-on-error'])

    // The broken tenant failed, so the run reports failure...
    assert.equal(code, 1, 'a failed tenant makes the command exit non-zero')
    // ...but --continue-on-error means the healthy tenants were still processed,
    // regardless of where the broken one fell in the iteration order.
    assert.equal(await notesCount(healthyA.id), 2, 'tenant before/around the failure was seeded')
    assert.equal(await notesCount(healthyC.id), 2, 'tenant after the failure was still reached')

    const brokenRow = await Tenant.findOrFail(broken.id)
    assert.equal(
      brokenRow.status,
      'active',
      'the broken tenant is a real active tenant, just unmigrated'
    )
  })

  test('default (no flag): a failing tenant surfaces as a non-zero exit', async ({
    client,
    assert,
  }) => {
    const broken = await createInstalledTenant(client, { migrate: false })

    assert.equal(
      await runAce('tenant:seed', ['--tenant', broken.id]),
      1,
      'seeding a tenant with no `notes` table must fail loudly, not silently exit 0'
    )
  })
})

/**
 * tenant:exec is the generic per-tenant command runner. Prove it surfaces an
 * inner-command failure as a non-zero exit (so a broken bulk operation can't
 * pass a CI/cron gate green) and that --dry-run is a pure no-op.
 */
test.group('e2e — CLI failure robustness (tenant:exec)', (group) => {
  group.each.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('--dry-run runs nothing and exits 0', async ({ client, assert }) => {
    await createInstalledTenant(client, { migrate: false })
    // The inner command is never executed under --dry-run, so a name that does
    // not exist is fine — a 0 exit proves nothing ran.
    assert.equal(await runAce('tenant:exec', ['--dry-run', 'this:never:runs']), 0)
  })

  test('an inner-command failure exits non-zero (default and --continue-on-error)', async ({
    client,
    assert,
  }) => {
    await createInstalledTenant(client, { migrate: false })

    assert.equal(
      await runAce('tenant:exec', ['definitely-not-a-command']),
      1,
      'an unknown inner command fails the run'
    )
    assert.equal(
      await runAce('tenant:exec', ['definitely-not-a-command', '--continue-on-error']),
      1,
      'continue-on-error still reports the failure as a non-zero exit'
    )
  })
})

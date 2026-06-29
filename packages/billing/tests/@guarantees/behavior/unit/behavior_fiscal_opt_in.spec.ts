import { test } from '@japa/runner'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

/**
 * Track B fiscal features are OPT-IN. The manifest's `migrations` dir (which the
 * core `--with=` path and the base configure publish) must point at the base
 * dir only; the fiscal DDL lives in a separate dir that billing's own configure
 * hook publishes solely when the operator opts in. These structural assertions
 * pin that separation so a stray file can't leak the fiscal DDL into the bulk
 * install path.
 */
test.group('Fiscal features are opt-in (separate stub dir)', () => {
  test('the manifest migrations dir is the base dir, not the fiscal one', async ({ assert }) => {
    const pkg = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
    assert.equal(pkg.lasagnaSatellite.migrations, 'stubs/migrations')
  })

  test('fiscal stubs live ONLY under stubs/migrations-fiscal, never the base dir', async ({
    assert,
  }) => {
    const base = await readdir(join(pkgRoot, 'stubs', 'migrations'))
    const fiscal = await readdir(join(pkgRoot, 'stubs', 'migrations-fiscal'))

    assert.includeMembers(fiscal, [
      'add_country_code_to_billing_customers.stub',
      'create_billing_invoice_snapshots_table.stub',
    ])
    assert.notInclude(base, 'add_country_code_to_billing_customers.stub')
    assert.notInclude(base, 'create_billing_invoice_snapshots_table.stub')
  })
})

import { test } from '@japa/runner'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { repoRoot } from '../../../../../satellite-test-kit/src/repo_root.js'
import { readSatelliteManifest } from '../../../../src/sdk/manifest.js'

const packagesDir = join(repoRoot(import.meta.url), 'packages')

async function manifestOf(pkg: string) {
  const root = join(packagesDir, pkg)
  const pkgJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  return { root, manifest: readSatelliteManifest(pkgJson) }
}

test.group('satellite — real package manifests round-trip', () => {
  test('billing declares a valid manifest with quotas as a requirement', async ({ assert }) => {
    const { root, manifest } = await manifestOf('billing')
    assert.isNotNull(manifest)
    assert.equal(manifest!.name, 'billing')
    assert.equal(manifest!.satelliteApi, 1)
    assert.include(manifest!.aliases ?? [], 'billing')
    assert.deepEqual(manifest!.requires, ['quotas'])
    assert.equal(manifest!.provider, '@adonisjs-lasagna/billing/provider')
    assert.equal(manifest!.commands, '@adonisjs-lasagna/billing/commands')

    // The declared migrations dir exists and holds the billing stubs (the four
    // create-table stubs plus the per-tenant uniqueness fix migration).
    const files = await readdir(join(root, manifest!.migrations!))
    for (const stub of [
      'create_billing_customers_table.stub',
      'create_billing_subscriptions_table.stub',
      'create_billing_processed_events_table.stub',
      'create_billing_usage_events_table.stub',
      'fix_billing_usage_events_unique_per_tenant.stub',
    ]) {
      assert.include(files, stub)
    }
    // tenant_plans stays in core — billing must NOT own it.
    assert.notInclude(files, 'create_tenant_plans_table.stub')
  })

  test('sso declares a valid manifest and ships its migration', async ({ assert }) => {
    const { root, manifest } = await manifestOf('sso')
    assert.isNotNull(manifest)
    assert.equal(manifest!.name, 'sso')
    assert.include(manifest!.aliases ?? [], 'sso')
    // sso ships no provider/commands.
    assert.isUndefined(manifest!.provider)
    const files = await readdir(join(root, manifest!.migrations!))
    assert.include(files, 'create_tenant_sso_configs_table.stub')
  })

  test('the satellite template declares a valid manifest', async ({ assert }) => {
    const { root, manifest } = await manifestOf('satellite-template')
    assert.isNotNull(manifest)
    assert.equal(manifest!.name, 'example-widgets')
    assert.equal(manifest!.satelliteApi, 1)
    const files = await readdir(join(root, manifest!.migrations!))
    assert.include(files, 'create_example_widgets_table.stub')
  })
})

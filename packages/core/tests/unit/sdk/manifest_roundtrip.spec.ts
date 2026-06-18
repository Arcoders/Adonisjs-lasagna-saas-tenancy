import { test } from '@japa/runner'
import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readSatelliteManifest } from '../../../src/sdk/manifest.js'

// packages/core/tests/unit/sdk → packages/
const packagesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')

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
    assert.include(manifest!.aliases ?? [], 'billing')
    assert.deepEqual(manifest!.requires, ['quotas'])
    assert.equal(manifest!.provider, '@adonisjs-lasagna/billing/provider')
    assert.equal(manifest!.commands, '@adonisjs-lasagna/billing/commands')

    // The declared migrations dir exists and holds the four billing stubs.
    const files = await readdir(join(root, manifest!.migrations!))
    for (const stub of [
      'create_billing_customers_table.stub',
      'create_billing_subscriptions_table.stub',
      'create_billing_processed_events_table.stub',
      'create_billing_usage_events_table.stub',
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
    const files = await readdir(join(root, manifest!.migrations!))
    assert.include(files, 'create_example_widgets_table.stub')
  })
})

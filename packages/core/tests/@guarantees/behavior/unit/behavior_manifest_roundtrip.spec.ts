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
    // sso now ships a minimal definePlugin backstop provider (asserts ABI +
    // plugin-API at boot); it still ships no commands.
    assert.equal(manifest!.provider, '@adonisjs-lasagna/sso/provider')
    assert.equal(manifest!.pluginApiVersion, 1)
    assert.isUndefined(manifest!.commands)
    const files = await readdir(join(root, manifest!.migrations!))
    assert.include(files, 'create_tenant_sso_configs_table.stub')
  })

  test('the satellite template declares a valid manifest', async ({ assert }) => {
    const { root, manifest } = await manifestOf('satellite-template')
    assert.isNotNull(manifest)
    assert.equal(manifest!.name, 'example-widgets')
    assert.equal(manifest!.satelliteApi, 1)
    // The template is a definePlugin facade, so it mirrors pluginApiVersion (no longer a
    // phantom field): the manifest declares it and check-abi-boot-assertion pins it.
    assert.equal(manifest!.pluginApiVersion, 1)
    const files = await readdir(join(root, manifest!.migrations!))
    assert.include(files, 'create_example_widgets_table.stub')
  })

  test('reporting mirrors pluginApiVersion + models minMergedCoverage', async ({ assert }) => {
    const { manifest } = await manifestOf('reporting')
    assert.isNotNull(manifest)
    assert.equal(manifest!.pluginApiVersion, 1)
    // minMergedCoverage is now modeled on the typed manifest, not only raw JSON.
    assert.isObject(manifest!.minMergedCoverage)
    assert.isAbove(manifest!.minMergedCoverage!.lines!, 0)
  })
})

test.group('readSatelliteManifest — pluginApiVersion + minMergedCoverage parsing', () => {
  const parse = (extra: Record<string, unknown>) =>
    readSatelliteManifest({ name: 'x', lasagnaSatellite: { name: 'x', ...extra } })

  test('accepts a positive-integer pluginApiVersion', ({ assert }) => {
    assert.equal(parse({ pluginApiVersion: 2 })!.pluginApiVersion, 2)
  })

  test('drops a non-positive / non-integer pluginApiVersion', ({ assert }) => {
    assert.isUndefined(parse({ pluginApiVersion: 0 })!.pluginApiVersion)
    assert.isUndefined(parse({ pluginApiVersion: 1.5 })!.pluginApiVersion)
    assert.isUndefined(parse({ pluginApiVersion: 'nope' })!.pluginApiVersion)
  })

  test('parses minMergedCoverage keeping only valid percentage metrics', ({ assert }) => {
    const m = parse({ minMergedCoverage: { lines: 90, functions: 88, branches: 200, bogus: 5 } })!
    assert.deepEqual(m.minMergedCoverage, { lines: 90, functions: 88 })
  })

  test('drops minMergedCoverage that is not an object of numbers', ({ assert }) => {
    assert.isUndefined(parse({ minMergedCoverage: [] })!.minMergedCoverage)
    assert.isUndefined(parse({ minMergedCoverage: { lines: 'x' } })!.minMergedCoverage)
  })
})

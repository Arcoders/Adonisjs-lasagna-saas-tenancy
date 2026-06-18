import { test } from '@japa/runner'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { discoverSatellites } from '../../../src/sdk/configure_kit.js'

/**
 * End-to-end proof that `discoverSatellites` resolves the REAL official packages
 * (billing + sso) from a host that depends on them. This is what exercises the
 * `resolvePackageRoot` *fallback*: billing/sso ship an `exports` map with no
 * `./package.json` entry, so `require.resolve('<pkg>/package.json')` throws and
 * discovery must resolve the entry + walk up. Layer-2 covers that mechanism with
 * a synthetic fixture; this locks it against the actual packages.
 *
 * It self-skips when the workspace isn't installed + built (e.g. a CI unit job
 * that hasn't run `build:all`, or a fresh checkout). Resolution of the package
 * entry is the cheapest "is it really here?" probe.
 */

// packages/core/tests/unit/sdk → repo root → examples/api
const examplesApiRoot = fileURLToPath(new URL('../../../../../examples/api/', import.meta.url))

function workspaceInstalled(): boolean {
  try {
    createRequire(join(examplesApiRoot, 'package.json')).resolve('@adonisjs-lasagna/billing')
    return true
  } catch {
    return false
  }
}

test.group('satellite — real-package discovery (examples/api)', () => {
  test('discovers billing + sso, including the exports-map fallback', async ({ assert }) => {
    const found = await discoverSatellites(examplesApiRoot)
    const names = found.map((s) => s.packageName)
    assert.include(names, '@adonisjs-lasagna/billing')
    assert.include(names, '@adonisjs-lasagna/sso')

    const billing = found.find((s) => s.packageName === '@adonisjs-lasagna/billing')!
    assert.equal(billing.manifest.name, 'billing')
    assert.deepEqual(billing.manifest.requires, ['quotas'])
    assert.equal(billing.manifest.provider, '@adonisjs-lasagna/billing/provider')

    const sso = found.find((s) => s.packageName === '@adonisjs-lasagna/sso')!
    assert.equal(sso.manifest.name, 'sso')
  }).skip(
    !workspaceInstalled(),
    'examples/api workspace not installed/built — CI/local-with-install only'
  )
})

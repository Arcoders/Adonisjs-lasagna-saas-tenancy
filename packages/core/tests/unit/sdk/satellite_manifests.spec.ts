import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { readSatelliteManifest } from '../../../src/sdk/manifest.js'
import { SATELLITE_API_VERSION } from '../../../src/sdk/api_version.js'

/**
 * Every publishable satellite in this monorepo must be auto-describable: it must
 * carry a valid `lasagnaSatellite` manifest declaring the Satellite ABI version
 * it was built against. This is the BX3 gate that brought `backup` and `admin`
 * into the ABI safety net (they previously shipped no manifest, so discovery and
 * the ABI-compat check skipped them).
 *
 * Reading manifests is side-effect-free (plain JSON, the package is never
 * imported), so this runs in the bare unit runner.
 */

// packages/core/tests/unit/sdk -> repo root -> packages/
const packagesDir = fileURLToPath(new URL('../../../../', import.meta.url))

function manifestFor(pkgDir: string) {
  const pkgJson = JSON.parse(readFileSync(join(packagesDir, pkgDir, 'package.json'), 'utf8'))
  return { pkgJson, manifest: readSatelliteManifest(pkgJson) }
}

/** Every package directory that should be a first-class satellite. */
const satellitePackages = ['billing', 'sso', 'backup', 'websockets', 'admin', 'satellite-template']

test.group('satellite manifests — auto-describable + ABI-versioned', () => {
  for (const pkg of satellitePackages) {
    test(`${pkg} declares a valid manifest at the current ABI`, ({ assert }) => {
      const { manifest } = manifestFor(pkg)
      assert.isNotNull(manifest, `${pkg} has no lasagnaSatellite manifest`)
      assert.isString(manifest!.name)
      assert.equal(
        manifest!.satelliteApi,
        SATELLITE_API_VERSION,
        `${pkg} must declare satelliteApi === ${SATELLITE_API_VERSION}`
      )
    })
  }

  test('every satellite package has an adonisjs.configure hook', ({ assert }) => {
    for (const pkg of satellitePackages) {
      const { pkgJson } = manifestFor(pkg)
      assert.isString(
        pkgJson?.adonisjs?.configure,
        `${pkg} must declare adonisjs.configure so \`node ace configure\` works`
      )
    }
  })

  test('backup registers a provider + commands (it ships both)', ({ assert }) => {
    const { manifest } = manifestFor('backup')
    assert.equal(manifest!.provider, '@adonisjs-lasagna/backup/provider')
    assert.equal(manifest!.commands, '@adonisjs-lasagna/backup/commands')
  })

  test('admin is guidance-only: no provider/commands to wire into adonisrc', ({ assert }) => {
    const { manifest } = manifestFor('admin')
    assert.isUndefined(manifest!.provider)
    assert.isUndefined(manifest!.commands)
  })
})

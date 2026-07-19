import { test } from '@japa/runner'
import { join, relative } from 'node:path'
import { readSatelliteManifest } from '../../../../src/sdk/manifest.js'
import { buildMigrationAliasMap } from '../../../../src/sdk/configure_kit.js'
import type { DiscoveredSatellite } from '../../../../src/sdk/manifest.js'

/**
 * Part D unit tier — the manifest alias parser (validate-and-drop) and the fleet alias
 * map builder (ownership by construction, fail-closed on collision/chain). These are the
 * static half of the relocation defense; a mis-declared `from` is bounded to a no-op
 * refusal by the reconcile gates, but the map itself must never admit a hijack.
 */
const HOST = join('/', 'app')

function sat(
  name: string,
  root: string,
  perTenantMigrations: string | undefined,
  aliases: Array<{ from: string; migration: string }>
): DiscoveredSatellite {
  return {
    packageName: `@x/${name}`,
    root,
    version: '1.0.0',
    manifest: { name, ...(perTenantMigrations ? { perTenantMigrations } : {}), migrationAliases: aliases },
  }
}

const expectedTo = (root: string, dir: string, migration: string): string =>
  `${relative(HOST, join(root, dir)).replace(/\\/g, '/')}/${migration}`

test.group('readSatelliteManifest — migrationAliases parsing', () => {
  test('parses a valid alias array', ({ assert }) => {
    const m = readSatelliteManifest({
      name: '@x/crypto',
      lasagnaSatellite: {
        name: 'crypto',
        migrationAliases: [{ from: 'database/migrations/tenant/0013_x', migration: '1751_x' }],
      },
    })
    assert.deepEqual(m?.migrationAliases, [
      { from: 'database/migrations/tenant/0013_x', migration: '1751_x' },
    ])
  })

  test('drops an entry whose migration has a path separator or .. segment', ({ assert }) => {
    const warns: string[] = []
    const m = readSatelliteManifest(
      {
        name: '@x/crypto',
        lasagnaSatellite: {
          name: 'crypto',
          migrationAliases: [
            { from: 'a', migration: 'sub/dir_x' },
            { from: 'b', migration: '../escape' },
            { from: 'c', migration: 'ok_x' },
          ],
        },
      },
      (w) => warns.push(w)
    )
    assert.deepEqual(m?.migrationAliases, [{ from: 'c', migration: 'ok_x' }])
    assert.lengthOf(warns, 2)
  })

  test('drops the whole field when it is not an array', ({ assert }) => {
    const warns: string[] = []
    const m = readSatelliteManifest(
      { name: '@x/crypto', lasagnaSatellite: { name: 'crypto', migrationAliases: 'nope' } },
      (w) => warns.push(w)
    )
    assert.isUndefined(m?.migrationAliases)
    assert.lengthOf(warns, 1)
  })
})

test.group('buildMigrationAliasMap — fleet map', () => {
  test('resolves an owned alias, keyed by the canonical to name', ({ assert }) => {
    const s = sat('crypto', join('/', 'pkgs', 'crypto'), 'build/tm', [
      { from: 'database/migrations/tenant/0013_x', migration: '1751_x' },
    ])
    const map = buildMigrationAliasMap(HOST, [s])
    const to = expectedTo(s.root, 'build/tm', '1751_x')
    assert.equal(map.size, 1)
    assert.deepEqual(map.get(to), {
      from: 'database/migrations/tenant/0013_x',
      to,
      ownerPackage: '@x/crypto',
      ownerSlug: 'crypto',
    })
  })

  test('drops a satellite that declares aliases but no perTenantMigrations (owns no target)', ({
    assert,
  }) => {
    const warns: string[] = []
    const s = sat('crypto', join('/', 'pkgs', 'crypto'), undefined, [
      { from: 'a', migration: '1751_x' },
    ])
    const map = buildMigrationAliasMap(HOST, [s], (w) => warns.push(w))
    assert.equal(map.size, 0)
    assert.isAbove(warns.length, 0)
  })

  test('fail-closed: a duplicate `to` across satellites drops the ENTIRE map', ({ assert }) => {
    // Two satellites resolving the same to (same dir + migration) is a fleet collision.
    const a = sat('a', join('/', 'pkgs', 'shared'), 'build/tm', [{ from: 'x', migration: '1751_x' }])
    const b = sat('b', join('/', 'pkgs', 'shared'), 'build/tm', [{ from: 'y', migration: '1751_x' }])
    const warns: string[] = []
    const map = buildMigrationAliasMap(HOST, [a, b], (w) => warns.push(w))
    assert.equal(map.size, 0, 'the whole map is dropped on collision')
    assert.isAbove(warns.length, 0)
  })

  test('fail-closed: a duplicate `from` across satellites drops the ENTIRE map', ({ assert }) => {
    const a = sat('a', join('/', 'pkgs', 'a'), 'build/tm', [{ from: 'shared_from', migration: '1751_a' }])
    const b = sat('b', join('/', 'pkgs', 'b'), 'build/tm', [{ from: 'shared_from', migration: '1751_b' }])
    const map = buildMigrationAliasMap(HOST, [a, b])
    assert.equal(map.size, 0)
  })

  test('fail-closed: a chain (a `to` is also a `from`) drops the ENTIRE map', ({ assert }) => {
    // Alias A's `to` equals alias B's `from` — a relocation chain, never allowed.
    const a = sat('a', join('/', 'pkgs', 'a'), 'build/tm', [{ from: 'legacy', migration: '1751_a' }])
    const toA = expectedTo(a.root, 'build/tm', '1751_a')
    const b = sat('b', join('/', 'pkgs', 'b'), 'build/tm', [{ from: toA, migration: '1751_b' }])
    const map = buildMigrationAliasMap(HOST, [a, b])
    assert.equal(map.size, 0)
  })
})

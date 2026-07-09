import { test } from '@japa/runner'
import { satisfiesRange, resolveSatelliteDependencies } from '../../../../src/sdk/dependencies.js'
import { indexSatellites } from '../../../../src/sdk/configure_kit.js'
import type { DiscoveredSatellite, SatelliteDependency } from '../../../../src/sdk/manifest.js'

function sat(
  packageName: string,
  opts: { version?: string; dependsOn?: SatelliteDependency[] } = {}
): DiscoveredSatellite {
  return {
    packageName,
    root: `/tmp/${packageName}`,
    version: opts.version,
    manifest: {
      name: packageName,
      ...(opts.dependsOn !== undefined ? { dependsOn: opts.dependsOn } : {}),
    },
  }
}

test.group('sdk — satisfiesRange', () => {
  test('any range matches', ({ assert }) => {
    for (const r of ['', '*', 'x', 'X', 'latest']) assert.isTrue(satisfiesRange('1.2.3', r))
  })

  test('exact + x-ranges', ({ assert }) => {
    assert.isTrue(satisfiesRange('1.2.3', '1.2.3'))
    assert.isTrue(satisfiesRange('1.2.3', '=1.2.3'))
    assert.isFalse(satisfiesRange('1.2.4', '1.2.3'))
    assert.isTrue(satisfiesRange('1.9.9', '1.x'))
    assert.isFalse(satisfiesRange('2.0.0', '1.x'))
    assert.isTrue(satisfiesRange('1.2.9', '1.2.x'))
    assert.isFalse(satisfiesRange('1.3.0', '1.2.x'))
  })

  test('caret', ({ assert }) => {
    assert.isTrue(satisfiesRange('1.4.0', '^1.2.3'))
    assert.isFalse(satisfiesRange('2.0.0', '^1.2.3'))
    assert.isFalse(satisfiesRange('1.2.2', '^1.2.3'))
    // 0.x caret stays within the minor
    assert.isTrue(satisfiesRange('0.2.9', '^0.2.3'))
    assert.isFalse(satisfiesRange('0.3.0', '^0.2.3'))
    // ^0.0.x pins the patch (npm: ^0.0.3 := >=0.0.3 <0.0.4)
    assert.isTrue(satisfiesRange('0.0.3', '^0.0.3'))
    assert.isFalse(satisfiesRange('0.0.4', '^0.0.3'))
    assert.isFalse(satisfiesRange('0.0.9', '^0.0.3'))
  })

  test('tilde', ({ assert }) => {
    assert.isTrue(satisfiesRange('1.2.9', '~1.2.3'))
    assert.isFalse(satisfiesRange('1.3.0', '~1.2.3'))
    assert.isTrue(satisfiesRange('1.9.0', '~1'))
    assert.isFalse(satisfiesRange('2.0.0', '~1'))
  })

  test('comparators', ({ assert }) => {
    assert.isTrue(satisfiesRange('2.0.0', '>=2.0.0'))
    assert.isFalse(satisfiesRange('1.9.9', '>=2.0.0'))
    assert.isTrue(satisfiesRange('2.0.1', '>2.0.0'))
    assert.isTrue(satisfiesRange('1.0.0', '<2.0.0'))
    assert.isTrue(satisfiesRange('2.0.0', '<=2.0.0'))
  })

  test('unsupported / unparseable ranges → null (treated as satisfied by the caller)', ({
    assert,
  }) => {
    assert.isNull(satisfiesRange('1.2.3', '>=1.0.0 <2.0.0')) // compound
    assert.isNull(satisfiesRange('1.2.3', '1.0.0 || 2.0.0')) // or
    assert.isNull(satisfiesRange('not-a-version', '^1.0.0')) // bad version
    // trailing junk must NOT match a leading prefix (end-anchored)
    assert.isNull(satisfiesRange('1.2.3', '1.2.3.4'))
    assert.isNull(satisfiesRange('1.2.3', '^1.2.3.4'))
    assert.isNull(satisfiesRange('1.0.0', '1.0beta'))
    assert.isNull(satisfiesRange('1.2.3', '1.2.x.y'))
  })

  test('ignores pre-release / build metadata on the version', ({ assert }) => {
    assert.isTrue(satisfiesRange('1.2.3-beta.1', '^1.2.0'))
    assert.isTrue(satisfiesRange('1.2.3+build.5', '~1.2.0'))
  })
})

test.group('sdk — resolveSatelliteDependencies', () => {
  test('orders a dependency before its dependent and pulls it in', ({ assert }) => {
    const a = sat('@me/a', { dependsOn: [{ pkg: '@me/b' }] })
    const b = sat('@me/b')
    const index = indexSatellites([a, b])
    const r = resolveSatelliteDependencies([a], index) // only A selected; B pulled in
    assert.deepEqual(
      r.ordered.map((s) => s.packageName),
      ['@me/b', '@me/a']
    )
    assert.deepEqual(r.missing, [])
    assert.isNull(r.cycle)
  })

  test('reports a missing dependency', ({ assert }) => {
    const a = sat('@me/a', { dependsOn: [{ pkg: '@me/ghost' }] })
    const index = indexSatellites([a])
    const r = resolveSatelliteDependencies([a], index)
    assert.deepEqual(r.missing, [{ from: '@me/a', pkg: '@me/ghost' }])
  })

  test('detects a cycle', ({ assert }) => {
    const a = sat('@me/a', { dependsOn: [{ pkg: '@me/b' }] })
    const b = sat('@me/b', { dependsOn: [{ pkg: '@me/a' }] })
    const index = indexSatellites([a, b])
    const r = resolveSatelliteDependencies([a, b], index)
    assert.deepEqual(r.cycle, ['@me/a', '@me/b'])
  })

  test('reports a range mismatch but still orders the graph', ({ assert }) => {
    const a = sat('@me/a', { dependsOn: [{ pkg: '@me/b', range: '^2.0.0' }] })
    const b = sat('@me/b', { version: '1.5.0' })
    const index = indexSatellites([a, b])
    const r = resolveSatelliteDependencies([a], index)
    assert.deepEqual(r.rangeMismatches, [
      { from: '@me/a', pkg: '@me/b', range: '^2.0.0', actual: '1.5.0' },
    ])
    assert.deepEqual(
      r.ordered.map((s) => s.packageName),
      ['@me/b', '@me/a']
    )
  })

  test('a satisfied range produces no mismatch', ({ assert }) => {
    const a = sat('@me/a', { dependsOn: [{ pkg: '@me/b', range: '^1.0.0' }] })
    const b = sat('@me/b', { version: '1.5.0' })
    const r = resolveSatelliteDependencies([a], indexSatellites([a, b]))
    assert.deepEqual(r.rangeMismatches, [])
  })

  test('transitive ordering (a → b → c)', ({ assert }) => {
    const a = sat('@me/a', { dependsOn: [{ pkg: '@me/b' }] })
    const b = sat('@me/b', { dependsOn: [{ pkg: '@me/c' }] })
    const c = sat('@me/c')
    const r = resolveSatelliteDependencies([a], indexSatellites([a, b, c]))
    assert.deepEqual(
      r.ordered.map((s) => s.packageName),
      ['@me/c', '@me/b', '@me/a']
    )
  })
})

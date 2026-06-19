import { test } from '@japa/runner'
import { SATELLITE_API_VERSION, checkSatelliteApiCompat } from '../../../src/sdk/api_version.js'
import * as sdk from '../../../src/sdk/index.js'

test.group('sdk — stable surface (B8 graduated helpers)', () => {
  test('exposes the pure tenant-id validators a satellite needs', ({ assert }) => {
    // These must stay on /sdk (bare-safe + stable). A satellite author relies on
    // them in its own unit runner; removing them is a breaking change.
    assert.isFunction(sdk.isUuidV4)
    assert.isFunction(sdk.assertSafeIdentifier)
    assert.isTrue(sdk.isUuidV4('3f2504e0-4f89-41d3-9a0c-0305e82c3301'))
    assert.isFalse(sdk.isUuidV4('not-a-uuid'))
    assert.throws(() => sdk.assertSafeIdentifier('bad"; DROP'))
  })
})

test.group('sdk — SATELLITE_API_VERSION', () => {
  test('is a positive integer', ({ assert }) => {
    assert.isTrue(Number.isInteger(SATELLITE_API_VERSION))
    assert.isAbove(SATELLITE_API_VERSION, 0)
  })
})

test.group('sdk — checkSatelliteApiCompat', () => {
  test('equal ABI → ok', ({ assert }) => {
    assert.deepEqual(checkSatelliteApiCompat({ satelliteApi: 2 }, '@me/sat', 2), { level: 'ok' })
  })

  test('satellite needs a NEWER ABI than core → fail (refuse to wire)', ({ assert }) => {
    const r = checkSatelliteApiCompat({ satelliteApi: 3 }, '@me/sat', 2)
    assert.equal(r.level, 'fail')
    assert.match((r as any).message, /requires Satellite ABI v3/)
    assert.match((r as any).message, /provides v2/)
  })

  test('satellite built for an OLDER ABI → warn (proceeds)', ({ assert }) => {
    const r = checkSatelliteApiCompat({ satelliteApi: 1 }, '@me/sat', 2)
    assert.equal(r.level, 'warn')
    assert.match((r as any).message, /built for Satellite ABI v1/)
  })

  test('undeclared satelliteApi → warn (unverified)', ({ assert }) => {
    const r = checkSatelliteApiCompat({}, '@me/sat', 2)
    assert.equal(r.level, 'warn')
    assert.match((r as any).message, /does not declare/)
  })

  test('defaults the core version to SATELLITE_API_VERSION', ({ assert }) => {
    assert.deepEqual(checkSatelliteApiCompat({ satelliteApi: SATELLITE_API_VERSION }, '@me/sat'), {
      level: 'ok',
    })
  })
})

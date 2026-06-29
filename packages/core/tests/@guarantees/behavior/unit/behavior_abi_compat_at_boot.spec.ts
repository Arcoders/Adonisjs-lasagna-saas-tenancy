import { test } from '@japa/runner'
import {
  assertSatelliteApiCompatAtBoot,
  SATELLITE_API_VERSION,
} from '../../../../src/sdk/api_version.js'

/**
 * WS-7 / abi-contract-check-configure-time-only.
 *
 * configure gates the Satellite ABI at install time, but that runs once — a later
 * core downgrade slips past it. assertSatelliteApiCompatAtBoot is the runtime
 * backstop each satellite provider calls in boot(): throw when the satellite needs
 * a NEWER ABI than the core provides, warn when older/absent, do nothing on equal.
 *
 * RED (pre-fix): no boot-time assert helper existed.
 */
test.group('assertSatelliteApiCompatAtBoot', () => {
  test('throws when the satellite needs a newer ABI than the core', ({ assert }) => {
    assert.throws(
      () =>
        assertSatelliteApiCompatAtBoot({ satelliteApi: SATELLITE_API_VERSION + 1 }, '@x/future'),
      /requires Satellite ABI v/
    )
  })

  test('warns (does not throw) when the satellite is older', ({ assert }) => {
    const warns: string[] = []
    assert.doesNotThrow(() =>
      assertSatelliteApiCompatAtBoot(
        { satelliteApi: SATELLITE_API_VERSION },
        '@x/old',
        (m) => warns.push(m),
        SATELLITE_API_VERSION + 1
      )
    )
    assert.lengthOf(warns, 1)
    assert.match(warns[0], /was built for Satellite ABI v/)
  })

  test('warns when satelliteApi is absent', ({ assert }) => {
    const warns: string[] = []
    assertSatelliteApiCompatAtBoot({}, '@x/unversioned', (m) => warns.push(m))
    assert.lengthOf(warns, 1)
    assert.match(warns[0], /does not declare/)
  })

  test('is a no-op on an exact match', ({ assert }) => {
    const warns: string[] = []
    assert.doesNotThrow(() =>
      assertSatelliteApiCompatAtBoot({ satelliteApi: SATELLITE_API_VERSION }, '@x/match', (m) =>
        warns.push(m)
      )
    )
    assert.lengthOf(warns, 0)
  })
})

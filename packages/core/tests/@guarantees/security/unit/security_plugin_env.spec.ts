import { test } from '@japa/runner'
import { trustedSatellites, isTrustedSatellite } from '../../../../src/sdk/plugin_env.js'

/**
 * The TRUSTED_SATELLITES allowlist reader (S5). It is the single source of the
 * plugin trust boundary: fail-closed (absence ⇒ untrusted), guard-minted (a
 * malformed entry is dropped, never smuggled), and memoized on the raw env string
 * (a test that reassigns the variable transparently re-parses).
 */

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const prev = process.env.TRUSTED_SATELLITES
  if (value === undefined) delete process.env.TRUSTED_SATELLITES
  else process.env.TRUSTED_SATELLITES = value
  try {
    return fn()
  } finally {
    if (prev === undefined) delete process.env.TRUSTED_SATELLITES
    else process.env.TRUSTED_SATELLITES = prev
  }
}

test.group('plugin_env — TRUSTED_SATELLITES allowlist', () => {
  test('unset or blank means nothing is trusted (fail-closed default)', ({ assert }) => {
    withEnv(undefined, () => {
      assert.deepEqual([...trustedSatellites()], [])
      assert.isFalse(isTrustedSatellite('reporting'))
    })
    withEnv('   ', () => {
      assert.deepEqual([...trustedSatellites()], [])
    })
  })

  test('parses a comma- and/or whitespace-separated list', ({ assert }) => {
    withEnv('reporting, analytics search', () => {
      assert.deepEqual([...trustedSatellites()].sort(), ['analytics', 'reporting', 'search'])
      assert.isTrue(isTrustedSatellite('reporting'))
      assert.isTrue(isTrustedSatellite('analytics'))
      assert.isTrue(isTrustedSatellite('search'))
      assert.isFalse(isTrustedSatellite('sketchy'))
    })
  })

  test('drops a malformed entry instead of failing (only safe names survive)', ({ assert }) => {
    withEnv('good, bad:name, ok_2, "quoted"', () => {
      // 'bad:name' and '"quoted"' fail assertSafeIdentifier and are dropped; the
      // valid ones remain, so a typo can only REMOVE reach, never grant it.
      assert.deepEqual([...trustedSatellites()].sort(), ['good', 'ok_2'])
      assert.isFalse(isTrustedSatellite('bad:name'))
    })
  })

  test('an unsafe name is never trusted even if the raw substring is present', ({ assert }) => {
    withEnv('bad:name', () => {
      assert.isFalse(isTrustedSatellite('bad:name'))
      assert.deepEqual([...trustedSatellites()], [])
    })
  })

  test('re-reads when the env string changes (memoized on raw value)', ({ assert }) => {
    withEnv('reporting', () => {
      assert.isTrue(isTrustedSatellite('reporting'))
      assert.isFalse(isTrustedSatellite('billing'))
    })
    withEnv('billing', () => {
      assert.isFalse(isTrustedSatellite('reporting'))
      assert.isTrue(isTrustedSatellite('billing'))
    })
  })
})

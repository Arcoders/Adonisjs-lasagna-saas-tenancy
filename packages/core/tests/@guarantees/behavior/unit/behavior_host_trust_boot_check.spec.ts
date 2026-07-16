import { test } from '@japa/runner'
import { assertConfigBounds } from '../../../../src/providers/assert_config_bounds.js'
import {
  hostTrustWarning,
  resolutionUsesHostStrategy,
} from '../../../../src/providers/assert_host_trust.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'

function config(overrides: Record<string, unknown>): MultitenancyConfig {
  return overrides as unknown as MultitenancyConfig
}

/** Run `fn` with NODE_ENV pinned, restoring it after. */
function withNodeEnv<T>(value: string, fn: () => T): T {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = value
  try {
    return fn()
  } finally {
    process.env.NODE_ENV = prev
  }
}

test.group('host-trust — strategy detection + warning verdict', () => {
  test('a host strategy with no expectedHostSuffix produces a warning', ({ assert }) => {
    const w = hostTrustWarning(config({ resolverStrategy: 'subdomain' }))
    assert.isNotNull(w)
    assert.match(w ?? '', /expectedHostSuffix|X-Forwarded-Host/)
  })

  test('domain-or-subdomain in a chain also triggers it', ({ assert }) => {
    assert.isNotNull(
      hostTrustWarning(
        config({ resolverStrategy: 'header', resolverChain: ['domain-or-subdomain'] })
      )
    )
  })

  test('expectedHostSuffix clears the warning', ({ assert }) => {
    assert.isNull(
      hostTrustWarning(
        config({ resolverStrategy: 'subdomain', resolver: { expectedHostSuffix: 'app.com' } })
      )
    )
    assert.isNull(
      hostTrustWarning(
        config({ resolverStrategy: 'subdomain', resolver: { expectedHostSuffix: ['app.com'] } })
      )
    )
  })

  test('a non-host strategy is never flagged', ({ assert }) => {
    assert.isFalse(resolutionUsesHostStrategy(config({ resolverStrategy: 'header' })))
    assert.isNull(hostTrustWarning(config({ resolverStrategy: 'header' })))
    assert.isNull(hostTrustWarning(config({ resolverStrategy: 'path' })))
  })
})

test.group('host-trust — assertConfigBounds production gate', () => {
  test('fails closed in production for a host strategy with no suffix', ({ assert }) => {
    withNodeEnv('production', () => {
      assert.throws(
        () => assertConfigBounds(config({ resolverStrategy: 'subdomain' })),
        /expectedHostSuffix|X-Forwarded-Host/
      )
    })
  })

  test('passes in production when expectedHostSuffix is set', ({ assert }) => {
    withNodeEnv('production', () => {
      assert.doesNotThrow(() =>
        assertConfigBounds(
          config({ resolverStrategy: 'subdomain', resolver: { expectedHostSuffix: 'app.com' } })
        )
      )
    })
  })

  test('passes in production for a non-host strategy (membership gate acknowledged)', ({
    assert,
  }) => {
    // `header` is not a host strategy, so the host-trust gate stays clear. It IS
    // client-controlled, so the resolution-safety audit would otherwise fail it on
    // the membership gate (WS-3); acknowledge that to isolate the host-trust case.
    withNodeEnv('production', () => {
      assert.doesNotThrow(() =>
        assertConfigBounds(
          config({ resolverStrategy: 'header', acknowledgeNoMembershipGate: true })
        )
      )
    })
  })

  test('does NOT fail outside production (the provider warns instead)', ({ assert }) => {
    withNodeEnv('development', () => {
      assert.doesNotThrow(() => assertConfigBounds(config({ resolverStrategy: 'subdomain' })))
    })
  })
})

import { test } from '@japa/runner'
import { assertConfigBounds } from '../../../../src/providers/assert_config_bounds.js'
import { resolutionSafetyAudit } from '../../../../src/providers/resolution_safety.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'

/**
 * WS-3: resolution safety is one audit feeding one enforcement voice. The matrix
 * here pins what counts as a finding (client-controlled x gate x ack x host x
 * suffix) and the production hard-fail behavior, which now covers the IDOR
 * posture as well as host-trust (the breaking change).
 */

function config(overrides: Record<string, unknown>): MultitenancyConfig {
  return overrides as unknown as MultitenancyConfig
}

function withNodeEnv<T>(value: string, fn: () => T): T {
  const prev = process.env.NODE_ENV
  process.env.NODE_ENV = value
  try {
    return fn()
  } finally {
    process.env.NODE_ENV = prev
  }
}

function codes(cfg: MultitenancyConfig): string[] {
  return resolutionSafetyAudit(cfg)
    .map((f) => f.code)
    .sort()
}

test.group('resolutionSafetyAudit — finding matrix', () => {
  test('client-controlled strategy with no gate => membership finding', ({ assert }) => {
    assert.deepEqual(codes(config({ resolverStrategy: 'header' })), ['membership_gate_missing'])
    assert.deepEqual(codes(config({ resolverStrategy: 'path' })), ['membership_gate_missing'])
  })

  test('host strategy with no suffix => host-trust finding', ({ assert }) => {
    assert.deepEqual(codes(config({ resolverStrategy: 'subdomain' })), ['host_trust_unbounded'])
  })

  test('a chain mixing both, unguarded, surfaces BOTH findings', ({ assert }) => {
    assert.deepEqual(codes(config({ resolverChain: ['subdomain', 'header'] })), [
      'host_trust_unbounded',
      'membership_gate_missing',
    ])
  })

  test('membership finding clears when authorizeTenantAccess is wired', ({ assert }) => {
    assert.deepEqual(
      codes(config({ resolverStrategy: 'header', authorizeTenantAccess: () => true })),
      []
    )
  })

  test('membership finding clears when acknowledged', ({ assert }) => {
    assert.deepEqual(
      codes(config({ resolverStrategy: 'header', acknowledgeNoMembershipGate: true })),
      []
    )
  })

  test('host finding clears when expectedHostSuffix is set', ({ assert }) => {
    assert.deepEqual(
      codes(config({ resolverStrategy: 'subdomain', resolver: { expectedHostSuffix: 'app.com' } })),
      []
    )
  })

  test('a server-controlled, gated, allowlisted config is clean', ({ assert }) => {
    assert.deepEqual(
      codes(
        config({
          resolverChain: ['subdomain', 'header'],
          authorizeTenantAccess: () => true,
          resolver: { expectedHostSuffix: ['app.com'] },
        })
      ),
      []
    )
  })
})

test.group('resolutionSafetyAudit — production hard-fail', () => {
  test('production boot throws on the IDOR posture (the WS-3 breaking change)', ({ assert }) => {
    withNodeEnv('production', () => {
      assert.throws(
        () => assertConfigBounds(config({ resolverStrategy: 'header' })),
        /IDOR|membership gate|authorizeTenantAccess/i
      )
    })
  })

  test('production boot succeeds once the IDOR posture is acknowledged', ({ assert }) => {
    withNodeEnv('production', () => {
      assert.doesNotThrow(() =>
        assertConfigBounds(
          config({ resolverStrategy: 'header', acknowledgeNoMembershipGate: true })
        )
      )
    })
  })

  test('dev boot does NOT throw on the IDOR posture (the provider warns instead)', ({ assert }) => {
    withNodeEnv('development', () => {
      assert.doesNotThrow(() => assertConfigBounds(config({ resolverStrategy: 'header' })))
    })
  })

  test('production boot reports both messages when both postures are unsafe', ({ assert }) => {
    withNodeEnv('production', () => {
      assert.throws(
        () => assertConfigBounds(config({ resolverChain: ['subdomain', 'header'] })),
        /expectedHostSuffix[\s\S]*authorizeTenantAccess|authorizeTenantAccess[\s\S]*expectedHostSuffix/i
      )
    })
  })
})

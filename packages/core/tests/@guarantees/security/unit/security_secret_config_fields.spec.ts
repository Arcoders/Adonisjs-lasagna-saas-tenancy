import { test } from '@japa/runner'
import { assertConfigBounds } from '../../../../src/providers/assert_config_bounds.js'
import { SECRET_CONFIG_FIELDS } from '../../../../src/providers/secret_config_fields.js'
import type { MultitenancyConfig } from '../../../../src/types/config.js'

/**
 * WS-2: secret-strength is enforced from one registry. These tests drive
 * assertConfigBounds through each enforced field (short rejected, adequate
 * accepted, absent handled per requiredWhen) and confirm exempt infra
 * credentials never fail the boot.
 */

function config(overrides: Record<string, unknown>): MultitenancyConfig {
  return overrides as unknown as MultitenancyConfig
}

const LONG = 'x'.repeat(32)

test.group('SECRET_CONFIG_FIELDS — enforced floors', () => {
  test('impersonation.secret: rejected when short, accepted when adequate', ({ assert }) => {
    assert.throws(
      () => assertConfigBounds(config({ impersonation: { secret: 'short' } })),
      /impersonation\.secret must be at least 32/
    )
    assert.doesNotThrow(() =>
      assertConfigBounds(config({ impersonation: { secret: LONG, defaultDuration: 300 } }))
    )
  })

  test('impersonation.secret: REQUIRED once the block is present (missing => throw)', ({
    assert,
  }) => {
    assert.throws(
      () => assertConfigBounds(config({ impersonation: { defaultDuration: 300 } })),
      /impersonation\.secret must be set and at least 32/
    )
  })

  test('maintenance.bypassToken: rejected short, accepted adequate, skipped when absent', ({
    assert,
  }) => {
    assert.throws(
      () => assertConfigBounds(config({ maintenance: { bypassToken: 'short' } })),
      /maintenance\.bypassToken must be at least 32/
    )
    assert.doesNotThrow(() => assertConfigBounds(config({ maintenance: { bypassToken: LONG } })))
    // Optional: an absent bypassToken is fine (no requiredWhen).
    assert.doesNotThrow(() => assertConfigBounds(config({ maintenance: { retryAfterSeconds: 5 } })))
  })

  test('no enforced field fires when its block is absent (a bare config boots)', ({ assert }) => {
    assert.doesNotThrow(() => assertConfigBounds(config({})))
  })
})

test.group('SECRET_CONFIG_FIELDS — exempt infra credentials', () => {
  test('a short queue/cache/replica password never fails the boot', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertConfigBounds(
        config({
          queue: { redis: { host: 'r', port: 6379, password: 'short' } },
          cache: { redis: { host: 'r', port: 6379, password: 'x' } },
        })
      )
    )
  })

  test('every exempt field carries a documented reason; every enforced field a minLength', ({
    assert,
  }) => {
    for (const field of SECRET_CONFIG_FIELDS) {
      if (field.enforce) {
        assert.isAbove(field.minLength ?? 0, 0, `${field.path} must declare a positive minLength`)
      } else {
        assert.isString(field.reason, `${field.path} must document why it is exempt`)
      }
    }
  })
})

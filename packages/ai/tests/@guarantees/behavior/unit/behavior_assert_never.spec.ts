import { test } from '@japa/runner'
import { assertNever } from '@adonisjs-lasagna/saas-tenancy/sdk'

/**
 * The AI package no longer ships its own `assertNever` copy: exhaustiveness is a
 * cross-cutting concern, so every layer now uses the one helper on the kernel's
 * `/sdk`. This pins that the shared helper is reachable from the satellite and
 * still throws loudly if control ever reaches it at runtime (an unchecked cast).
 */
test.group('assertNever (shared /sdk helper)', () => {
  test('throws loudly if control ever reaches it at runtime', ({ assert }) => {
    assert.throws(() => assertNever('leak' as never, 'outcome'), /Unhandled outcome: "leak"/)
  })
})

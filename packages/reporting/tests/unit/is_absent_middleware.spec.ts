import { test } from '@japa/runner'
import { isAbsentReportingMiddleware } from '../../src/is_absent_middleware.js'

/**
 * The reporting dashboard is fail-closed: it refuses to mount without an explicit
 * guard or an explicit `false` opt-out. Only a real, non-empty middleware (or
 * `false`) is acceptable; every "effectively absent" value must be rejected so
 * the fleet-wide analytics endpoint can never go public by accident. Imports the
 * router-free predicate directly (the routes barrel pulls in the router service,
 * which trips `app.booted`).
 */
test.group('isAbsentReportingMiddleware', () => {
  test('undefined / null / empty string are absent', ({ assert }) => {
    assert.isTrue(isAbsentReportingMiddleware(undefined))
    assert.isTrue(isAbsentReportingMiddleware(null))
    assert.isTrue(isAbsentReportingMiddleware(''))
  })

  test('an EMPTY ARRAY is absent (no silent public mount of cross-tenant analytics)', ({
    assert,
  }) => {
    assert.isTrue(isAbsentReportingMiddleware([]))
  })

  test('explicit false is the public opt-out, NOT absent', ({ assert }) => {
    assert.isFalse(isAbsentReportingMiddleware(false))
  })

  test('real middleware (name, fn, named-object, non-empty array) is not absent', ({ assert }) => {
    assert.isFalse(isAbsentReportingMiddleware('adminAuth'))
    assert.isFalse(isAbsentReportingMiddleware(() => {}))
    assert.isFalse(isAbsentReportingMiddleware({ name: 'adminAuth', handle: () => {} }))
    assert.isFalse(isAbsentReportingMiddleware(['adminAuth']))
  })
})

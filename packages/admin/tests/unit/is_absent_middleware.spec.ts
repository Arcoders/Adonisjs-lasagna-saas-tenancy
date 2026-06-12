import { test } from '@japa/runner'
import { isAbsentAdminMiddleware } from '../../src/is_absent_middleware.js'

/**
 * The admin API is fail-closed: it refuses to mount without an explicit guard
 * or an explicit `false` opt-out. Only a real, non-empty middleware (or `false`)
 * is acceptable; every "effectively absent" value must be rejected so the
 * destructive admin routes can never go public by accident. Imports the
 * router-free predicate directly (the routes barrel pulls in the router service,
 * which trips `app.booted`).
 */
test.group('isAbsentAdminMiddleware', () => {
  test('undefined / null / empty string are absent', ({ assert }) => {
    assert.isTrue(isAbsentAdminMiddleware(undefined))
    assert.isTrue(isAbsentAdminMiddleware(null))
    assert.isTrue(isAbsentAdminMiddleware(''))
  })

  test('an EMPTY ARRAY is absent (no silent public mount of destructive routes)', ({ assert }) => {
    assert.isTrue(isAbsentAdminMiddleware([]))
  })

  test('explicit false is the public opt-out, NOT absent', ({ assert }) => {
    assert.isFalse(isAbsentAdminMiddleware(false))
  })

  test('real middleware (name, fn, named-object, non-empty array) is not absent', ({ assert }) => {
    assert.isFalse(isAbsentAdminMiddleware('adminAuth'))
    assert.isFalse(isAbsentAdminMiddleware(() => {}))
    assert.isFalse(isAbsentAdminMiddleware({ name: 'adminAuth', handle: () => {} }))
    assert.isFalse(isAbsentAdminMiddleware(['adminAuth']))
  })
})

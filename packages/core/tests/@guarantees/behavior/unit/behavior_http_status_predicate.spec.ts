import { test } from '@japa/runner'
import { hasDecidedHttpStatus } from '../../../../src/extensions/request.js'
import TenantSuspendedException from '../../../../src/exceptions/tenant_suspended_exception.js'

/**
 * `hasDecidedHttpStatus` is the single source of truth for the tenant
 * lookup/connect catch sites: an error with a decided numeric `.status` passes
 * through, everything else is wrapped as a 503. These assertions pin the exact
 * boundary so a `statusCode`-vs-`status` typo (or a widened `any`) can't quietly
 * change which outages fail closed.
 */
test.group('hasDecidedHttpStatus', () => {
  test('true for an object carrying a numeric status', ({ assert }) => {
    assert.isTrue(hasDecidedHttpStatus({ status: 503 }))
    assert.isTrue(hasDecidedHttpStatus({ status: 404, code: 'E_TENANT_NOT_FOUND' }))
  })

  test('true for a real AdonisJS exception (status copied from the static)', ({ assert }) => {
    const exc = new TenantSuspendedException()
    assert.strictEqual(exc.status, 403)
    assert.isTrue(hasDecidedHttpStatus(exc))
  })

  test('false when status is absent, non-numeric, or the value is nullish', ({ assert }) => {
    assert.isFalse(hasDecidedHttpStatus({}))
    assert.isFalse(hasDecidedHttpStatus(null))
    assert.isFalse(hasDecidedHttpStatus(undefined))
    assert.isFalse(hasDecidedHttpStatus({ status: '500' }))
    assert.isFalse(hasDecidedHttpStatus(new Error('raw lucid failure')))
    assert.isFalse(hasDecidedHttpStatus('string'))
    assert.isFalse(hasDecidedHttpStatus(503))
  })
})

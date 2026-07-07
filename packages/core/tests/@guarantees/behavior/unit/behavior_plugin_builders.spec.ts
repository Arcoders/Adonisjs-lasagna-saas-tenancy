import { test } from '@japa/runner'
import {
  authorizer,
  middleware,
  requestMacro,
  defineCapability,
} from '../../../../src/sdk/builders.js'
import {
  AUTHORIZER_CONTRACT_VERSION,
  type TenantAuthorizer,
} from '../../../../src/services/authorizer_registry.js'
import { TENANT_MIDDLEWARE_CONTRACT_VERSION } from '../../../../src/services/tenant_middleware_registry.js'
import { CAPABILITY_CONTRACT_VERSION } from '../../../../src/services/capability_registry.js'

/**
 * E8 typed builders — the ergonomic authoring path. Each builder mints the
 * branded name (running assertSafeIdentifier, so a hostile name throws HERE at
 * authoring time), stamps the `kind` discriminant, and defaults `contractVersion`
 * to the surface constant, producing an entry byte-compatible with the raw
 * discriminated shape that `definePlugin` consumes.
 */

test.group('plugin builders — authorizer()', () => {
  test('stamps kind, mints the name, defaults the contract version', ({ assert }) => {
    const authorize: TenantAuthorizer = () => ({ allow: true })
    const entry = authorizer({ name: 'seat_limit', authorize })
    assert.equal(entry.kind, 'authorizer')
    assert.equal(entry.name, 'seat_limit')
    assert.strictEqual(entry.authorize, authorize)
    assert.equal(entry.contractVersion, AUTHORIZER_CONTRACT_VERSION)
    assert.isUndefined(entry.order)
  })

  test('passes order through and honors a contractVersion override', ({ assert }) => {
    const entry = authorizer({
      name: 'gate',
      authorize: () => ({ allow: true }),
      order: 5,
      contractVersion: 1,
    })
    assert.equal(entry.order, 5)
    assert.equal(entry.contractVersion, 1)
  })

  test('rejects a hostile name at build time', ({ assert }) => {
    assert.throws(
      () => authorizer({ name: 'evil:injected', authorize: () => ({ allow: true }) }),
      /unsafe/
    )
  })
})

test.group('plugin builders — middleware()', () => {
  test('stamps kind, mints the name, defaults scope-less with the contract version', ({
    assert,
  }) => {
    const handle = () => {}
    const entry = middleware({ name: 'request_id', middleware: { handle } })
    assert.equal(entry.kind, 'middleware')
    assert.equal(entry.name, 'request_id')
    assert.equal(entry.contractVersion, TENANT_MIDDLEWARE_CONTRACT_VERSION)
    assert.isUndefined(entry.scope)
    assert.isUndefined(entry.order)
  })

  test('passes scope + order through', ({ assert }) => {
    const entry = middleware({ name: 'm', middleware: () => {}, scope: 'central', order: 2 })
    assert.equal(entry.scope, 'central')
    assert.equal(entry.order, 2)
  })

  test('rejects a hostile name at build time', ({ assert }) => {
    assert.throws(() => middleware({ name: 'a b', middleware: () => {} }), /unsafe/)
  })
})

test.group('plugin builders — requestMacro()', () => {
  test('stamps kind, mints the name, preserves resolve + requireTenant', ({ assert }) => {
    const resolve = () => 'en'
    const spec = requestMacro({ name: 'locale', resolve, requireTenant: true })
    assert.equal(spec.kind, 'requestMacro')
    assert.equal(spec.name, 'locale')
    assert.strictEqual(spec.resolve, resolve)
    assert.isTrue(spec.requireTenant)
  })

  test('omits requireTenant when not set', ({ assert }) => {
    const spec = requestMacro({ name: 'x', resolve: () => 1 })
    assert.isUndefined(spec.requireTenant)
  })

  test('rejects a hostile name at build time', ({ assert }) => {
    assert.throws(() => requestMacro({ name: 'has:colon', resolve: () => 1 }), /unsafe/)
  })
})

test.group('plugin builders — defineCapability()', () => {
  test('stamps kind, mints the key, defaults the contract version', ({ assert }) => {
    const api = { send: () => {} }
    const entry = defineCapability({ name: 'email', api })
    assert.equal(entry.kind, 'capability')
    assert.equal(entry.name, 'email')
    assert.strictEqual(entry.api, api)
    assert.equal(entry.contractVersion, CAPABILITY_CONTRACT_VERSION)
  })

  test('rejects a hostile key at build time', ({ assert }) => {
    assert.throws(() => defineCapability({ name: 'a/b', api: {} }), /unsafe/)
  })
})

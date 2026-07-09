import { test } from '@japa/runner'
import { HttpRequest } from '@adonisjs/core/http'
import {
  registerTenantRequestMacro,
  __resetRequestMacrosForTests,
} from '../../../../src/extensions/request.js'
import { macroName } from '../../../../src/sdk/brands.js'

/** Reach the installed macro function off the prototype to invoke it with a
 *  crafted `this`, so memoization / requireTenant are unit-testable without a
 *  real HTTP request. */
function macroFn(name: string): (this: unknown) => Promise<unknown> {
  return (HttpRequest.prototype as unknown as Record<string, (this: unknown) => Promise<unknown>>)[
    name
  ]!
}

test.group('registerTenantRequestMacro', (group) => {
  group.each.teardown(() => __resetRequestMacrosForTests())

  test('installs a callable macro and memoizes the resolved value', async ({ assert }) => {
    let calls = 0
    registerTenantRequestMacro({
      kind: 'requestMacro',
      name: macroName('demoValue'),
      resolve: () => {
        calls++
        return { v: 42 }
      },
    })

    const fn = macroFn('demoValue')
    assert.isFunction(fn)

    const fakeReq: Record<string, unknown> = {}
    const a = await fn.call(fakeReq)
    const b = await fn.call(fakeReq)
    assert.deepEqual(a, { v: 42 })
    assert.strictEqual(a, b) // same memoized instance
    assert.equal(calls, 1) // resolve ran exactly once
  })

  test('a falsy/undefined resolved value memoizes once (presence check, not truthiness)', async ({
    assert,
  }) => {
    let calls = 0
    registerTenantRequestMacro({
      kind: 'requestMacro',
      name: macroName('maybeUndefined'),
      resolve: () => {
        calls++
        return undefined
      },
    })
    const fn = macroFn('maybeUndefined')
    const fakeReq: Record<string, unknown> = {}
    await fn.call(fakeReq)
    await fn.call(fakeReq)
    assert.equal(calls, 1)
  })

  test('requireTenant fails closed when no tenant resolves', async ({ assert }) => {
    registerTenantRequestMacro({
      kind: 'requestMacro',
      name: macroName('needsTenant'),
      requireTenant: true,
      resolve: () => 'should-not-reach',
    })
    const fn = macroFn('needsTenant')
    const fakeReq = {
      tenant: async () => {
        throw new Error('no tenant resolved')
      },
    }
    await assert.rejects(() => fn.call(fakeReq), /no tenant resolved/)
  })

  test('a duplicate macro name throws RequestMacroCollisionException (500)', ({ assert }) => {
    registerTenantRequestMacro({
      kind: 'requestMacro',
      name: macroName('dupMacro'),
      resolve: () => 1,
    })
    try {
      registerTenantRequestMacro({
        kind: 'requestMacro',
        name: macroName('dupMacro'),
        resolve: () => 2,
      })
      assert.fail('expected a collision throw')
    } catch (err: any) {
      assert.equal(err.code, 'E_REQUEST_MACRO_COLLISION')
      assert.equal(err.status, 500)
    }
  })

  test('registering over the built-in tenant() macro throws (no silent shadow)', ({ assert }) => {
    assert.throws(
      () =>
        registerTenantRequestMacro({
          kind: 'requestMacro',
          name: macroName('tenant'),
          resolve: () => 1,
        }),
      /already defined/
    )
  })

  test('an unsafe macro name is refused when minted', ({ assert }) => {
    assert.throws(() => macroName('bad name'), /unsafe/)
    assert.throws(() => macroName('has:colon'), /unsafe/)
  })
})

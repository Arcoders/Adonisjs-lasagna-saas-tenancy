import { test } from '@japa/runner'
import {
  installRouterMacros,
  __resetRouterMacrosForTests,
} from '../../../src/extensions/router.js'

function makeFakeRouter() {
  const groups: Array<{ used?: any[] }> = []
  const r: any = {
    group(_cb: () => void) {
      const g: any = { used: undefined as any[] | undefined }
      g.use = (mws: any[]) => {
        g.used = mws
        return g
      }
      g.prefix = () => g
      groups.push(g)
      return g
    },
  }
  return { router: r, groups }
}

test.group('installRouterMacros', (group) => {
  group.each.setup(() => __resetRouterMacrosForTests())

  test('adds tenant / central / universal as functions on the given router', async ({ assert }) => {
    const { router } = makeFakeRouter()
    await installRouterMacros(router)
    assert.isFunction(router.tenant)
    assert.isFunction(router.central)
    assert.isFunction(router.universal)
  })

  test('Router.tenant() wraps the group with TenantGuardMiddleware', async ({ assert }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.tenant(() => {})
    const used = groups[0].used as any[]
    assert.lengthOf(used, 1)
    assert.equal(used[0].constructor.name, 'TenantGuardMiddleware')
  })

  test('Router.central() wraps the group with CentralOnlyMiddleware', async ({ assert }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.central(() => {})
    const used = groups[0].used as any[]
    assert.equal(used[0].constructor.name, 'CentralOnlyMiddleware')
  })

  test('Router.universal() wraps the group with UniversalMiddleware', async ({ assert }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.universal(() => {})
    const used = groups[0].used as any[]
    assert.equal(used[0].constructor.name, 'UniversalMiddleware')
  })

  test('respects pre-existing macros (does not overwrite a user-defined tenant())', async ({
    assert,
  }) => {
    const { router } = makeFakeRouter()
    const stub = function () {
      return {} as any
    }
    router.tenant = stub
    await installRouterMacros(router)
    assert.strictEqual(router.tenant, stub)
  })

  test('is idempotent — second call leaves handlers intact', async ({ assert }) => {
    const { router } = makeFakeRouter()
    await installRouterMacros(router)
    const first = router.tenant
    __resetRouterMacrosForTests()
    await installRouterMacros(router)
    assert.strictEqual(router.tenant, first)
  })
})

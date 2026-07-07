import { test } from '@japa/runner'
import {
  installRouterMacros,
  __resetRouterMacrosForTests,
} from '../../../../src/extensions/router.js'
import TenantMiddlewareRegistry, {
  type TenantMiddleware,
} from '../../../../src/services/tenant_middleware_registry.js'
import { middlewareName } from '../../../../src/sdk/brands.js'

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

test.group('installRouterMacros — SEAM-2 plugin middleware', (group) => {
  group.each.setup(() => __resetRouterMacrosForTests())

  const mw = (id: string): TenantMiddleware =>
    ({ id, handle: () => {} }) as unknown as TenantMiddleware
  const usedIds = (list: any[]): string[] => list.slice(1).map((m) => m.id)

  test('stacks plugin middleware AFTER the core scope middleware, ordered by order', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    const registry = new TenantMiddlewareRegistry()
    registry.register({
      kind: 'middleware',
      name: middlewareName('b'),
      middleware: mw('b'),
      order: 2,
    })
    registry.register({
      kind: 'middleware',
      name: middlewareName('a'),
      middleware: mw('a'),
      order: 1,
    })

    await installRouterMacros(router, registry)
    router.tenant(() => {})
    const used = groups[0].used as any[]

    assert.equal(used[0].constructor.name, 'TenantGuardMiddleware') // core first
    assert.deepEqual(usedIds(used), ['a', 'b']) // plugin middleware after, ordered
  })

  test('routes middleware to its declared scope only', async ({ assert }) => {
    const { router, groups } = makeFakeRouter()
    const registry = new TenantMiddlewareRegistry()
    registry.register({ kind: 'middleware', name: middlewareName('t'), middleware: mw('t') }) // tenant default
    registry.register({
      kind: 'middleware',
      name: middlewareName('c'),
      middleware: mw('c'),
      scope: 'central',
    })

    await installRouterMacros(router, registry)
    router.tenant(() => {})
    router.central(() => {})

    const tenantUsed = groups[0].used as any[]
    const centralUsed = groups[1].used as any[]
    assert.equal(tenantUsed[0].constructor.name, 'TenantGuardMiddleware')
    assert.deepEqual(usedIds(tenantUsed), ['t'])
    assert.equal(centralUsed[0].constructor.name, 'CentralOnlyMiddleware')
    assert.deepEqual(usedIds(centralUsed), ['c'])
  })

  test('no registry → core middleware only (byte-identical to pre-seam)', async ({ assert }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router, new TenantMiddlewareRegistry())
    router.tenant(() => {})
    assert.lengthOf(groups[0].used as any[], 1)
  })
})

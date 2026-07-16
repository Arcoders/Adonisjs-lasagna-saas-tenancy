import { test } from '@japa/runner'
import {
  installRouterMacros,
  toRouteMiddleware,
  __resetRouterMacrosForTests,
} from '../../../../src/extensions/router.js'
import { __resetResolverRegistryCacheForTests } from '../../../../src/extensions/request.js'
import TenantMiddlewareRegistry, {
  type TenantMiddleware,
} from '../../../../src/services/tenant_middleware_registry.js'
import { middlewareName } from '../../../../src/sdk/brands.js'
import CentralRouteViolationException from '../../../../src/exceptions/central_route_violation_exception.js'
import { setupTestConfig } from '../../../helpers/config.js'

/**
 * The route executor (http-server `src/router/executor.ts`) runs middleware
 * in exactly two shapes: a plain function is invoked as `fn(ctx, next)`, and
 * anything else is treated as ParsedNamedMiddleware, whose `handle` receives
 * the CONTAINER RESOLVER first (`handle(resolver, ctx, next, args)`). The
 * macros once handed `.use()` bare instances behind an `as any`, which
 * satisfied neither shape and 500ed on every real request while the
 * structural specs here stayed green. So these specs pin the EXECUTABLE
 * contract, not just the wrapping: every entry a macro stacks must survive
 * this exact invocation.
 */
function executeAsHttpServerWould(entry: any, ctx: any, next: () => unknown) {
  if (typeof entry === 'function') return entry(ctx, next)
  return entry.handle({ iAmTheContainerResolver: true }, ctx, next, entry.args)
}

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

  test('every entry a macro stacks is a plain function (the executor-safe shape)', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    const registry = new TenantMiddlewareRegistry()
    registry.register({
      kind: 'middleware',
      name: middlewareName('fn-form'),
      middleware: (() => {}) as TenantMiddleware,
    })
    registry.register({
      kind: 'middleware',
      name: middlewareName('object-form'),
      middleware: { handle: () => {} },
    })

    await installRouterMacros(router, registry)
    router.tenant(() => {})
    router.central(() => {})
    router.universal(() => {})

    for (const g of groups) {
      for (const entry of g.used as any[]) {
        assert.isFunction(
          entry,
          'a non-function entry would be executed as ParsedNamedMiddleware, with the container resolver where the middleware expects the HttpContext'
        )
      }
    }
  })

  test('Router.tenant() wraps the group with the adapted TenantGuardMiddleware', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.tenant(() => {})
    const used = groups[0]!.used as any[]
    assert.lengthOf(used, 1)
    assert.equal(used[0].name, 'TenantGuardMiddleware')
  })

  test('Router.central() wraps the group with the adapted CentralOnlyMiddleware', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.central(() => {})
    const used = groups[0]!.used as any[]
    assert.equal(used[0].name, 'CentralOnlyMiddleware')
  })

  test('Router.universal() wraps the group with the adapted UniversalMiddleware', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.universal(() => {})
    const used = groups[0]!.used as any[]
    assert.equal(used[0].name, 'UniversalMiddleware')
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

test.group('installRouterMacros: entries execute under the route executor', (group) => {
  group.each.setup(() => {
    __resetRouterMacrosForTests()
    __resetResolverRegistryCacheForTests()
    setupTestConfig()
  })

  test('the tenant entry runs TenantGuardMiddleware with the real ctx (ignored path calls next)', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.tenant(() => {})
    const entry = (groups[0]!.used as any[])[0]

    // '/health' sits in the test config's ignorePaths, so a correctly wired
    // guard reads it off ctx.request and short-circuits to next(). Before the
    // adapter, this invocation handed the guard the container resolver, which
    // has no `request`, and the request died in a TypeError.
    let nextCalled = false
    const ctx = { request: { url: (_qs?: boolean) => '/health' } }
    await executeAsHttpServerWould(entry, ctx, () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('the central entry lets a tenant-less request through and rejects a tenant one', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.central(() => {})
    const entry = (groups[0]!.used as any[])[0]

    let nextCalled = false
    const anonymous = { request: { header: (_k: string) => undefined } }
    await executeAsHttpServerWould(entry, anonymous, () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled, 'no resolvable tenant means the central route serves')

    const withTenant = {
      request: { header: (_k: string) => '2c1ed1f6-8c3d-4b6e-9a3f-0d5b6a7c8d9e' },
    }
    let thrown: unknown = null
    try {
      await executeAsHttpServerWould(entry, withTenant, () => {})
    } catch (error) {
      thrown = error
    }
    assert.instanceOf(thrown, CentralRouteViolationException)
  })

  test('the universal entry degrades to central mode when no tenant resolves', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router)
    router.universal(() => {})
    const entry = (groups[0]!.used as any[])[0]

    let nextCalled = false
    const ctx = { request: { header: (_k: string) => undefined } }
    await executeAsHttpServerWould(entry, ctx, () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('object-form plugin middleware receives the HttpContext (never the resolver) with this bound', async ({
    assert,
  }) => {
    const { router, groups } = makeFakeRouter()
    const registry = new TenantMiddlewareRegistry()
    const seen: Array<{ self: unknown; ctx: unknown }> = []
    const objectMw = {
      handle(this: unknown, ctx: unknown, next: () => unknown) {
        seen.push({ self: this, ctx })
        return next()
      },
    }
    registry.register({
      kind: 'middleware',
      name: middlewareName('obj'),
      middleware: objectMw,
    })

    await installRouterMacros(router, registry)
    router.tenant(() => {})
    const pluginEntry = (groups[0]!.used as any[])[1]

    let nextCalled = false
    const ctx = { request: { url: () => '/anywhere' } }
    await executeAsHttpServerWould(pluginEntry, ctx, () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
    assert.strictEqual(seen[0]!.ctx, ctx, 'the middleware must see the ctx the executor passed')
    assert.strictEqual(seen[0]!.self, objectMw, 'this must stay bound to the registered object')
  })
})

test.group('installRouterMacros — SEAM-2 plugin middleware', (group) => {
  group.each.setup(() => __resetRouterMacrosForTests())

  // Adapted entries surface the wrapped middleware's name (function name or
  // constructor name), which is also what route debug traces print.
  const mw = (id: string): TenantMiddleware => {
    const f = (_ctx: unknown, _next: unknown) => {}
    Object.defineProperty(f, 'name', { value: id })
    return f as TenantMiddleware
  }
  const usedIds = (list: any[]): string[] => list.slice(1).map((m) => m.name)

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
    const used = groups[0]!.used as any[]

    assert.equal(used[0].name, 'TenantGuardMiddleware') // core first
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

    const tenantUsed = groups[0]!.used as any[]
    const centralUsed = groups[1]!.used as any[]
    assert.equal(tenantUsed[0].name, 'TenantGuardMiddleware')
    assert.deepEqual(usedIds(tenantUsed), ['t'])
    assert.equal(centralUsed[0].name, 'CentralOnlyMiddleware')
    assert.deepEqual(usedIds(centralUsed), ['c'])
  })

  test('no registry → core middleware only (byte-identical to pre-seam)', async ({ assert }) => {
    const { router, groups } = makeFakeRouter()
    await installRouterMacros(router, new TenantMiddlewareRegistry())
    router.tenant(() => {})
    assert.lengthOf(groups[0]!.used as any[], 1)
  })
})

test.group('toRouteMiddleware', () => {
  test('always returns a plain function, whatever shape comes in', async ({ assert }) => {
    assert.isFunction(toRouteMiddleware(() => {}))
    assert.isFunction(toRouteMiddleware({ handle: () => {} }))
  })

  test('falls back to a stable name for anonymous middleware', async ({ assert }) => {
    assert.equal(toRouteMiddleware({ handle: () => {} }).name, 'tenantScopedMiddleware')
    const named = toRouteMiddleware(mwNamed())
    assert.equal(named.name, 'myPluginMiddleware')
  })
})

function mwNamed(): TenantMiddleware {
  const myPluginMiddleware = (_ctx: unknown, _next: unknown) => {}
  return myPluginMiddleware as TenantMiddleware
}

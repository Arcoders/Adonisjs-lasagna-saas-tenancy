import { test } from '@japa/runner'
import {
  createSessionBootstrapper,
  tenantSessionKey,
  tenantSession,
  TENANT_SESSION_PREFIX,
} from '../../../src/services/bootstrappers/session_bootstrapper.js'
import BootstrapperRegistry from '../../../src/services/bootstrapper_registry.js'
import { tenancy, __configureTenancyForTests } from '../../../src/tenancy.js'
import TenantLogContext from '../../../src/services/tenant_log_context.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id = 'tenant-1') =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

test.group('sessionBootstrapper — metadata', () => {
  test('exposes the canonical name and prefix constant', ({ assert }) => {
    const b = createSessionBootstrapper()
    assert.equal(b.name, 'session')
    assert.equal(TENANT_SESSION_PREFIX, 'tenants/')
  })
})

test.group('tenantSessionKey()', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  test('throws outside a tenancy.run() scope', ({ assert }) => {
    assert.throws(() => tenantSessionKey('cart'), /outside a tenancy\.run\(\) scope/)
  })

  test('throws on empty / non-string keys', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })

    await tenancy.run(fakeTenant('abc'), async () => {
      assert.throws(() => tenantSessionKey(''), /non-empty string/)
      assert.throws(() => tenantSessionKey(undefined as any), /non-empty string/)
    })
  })

  test('produces tenants/<id>/<key>', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })

    await tenancy.run(fakeTenant('xyz'), async () => {
      assert.equal(tenantSessionKey('cart'), 'tenants/xyz/cart')
      assert.equal(tenantSessionKey('/cart'), 'tenants/xyz/cart')
      assert.equal(tenantSessionKey('user/preferences'), 'tenants/xyz/user/preferences')
    })
  })

  test('rejects unsafe tenant ids before forming the key', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })

    await tenancy.run({ id: '../escape' } as any, async () => {
      assert.throws(() => tenantSessionKey('cart'), /Refusing to use unsafe/)
    })
  })
})

test.group('tenantSession() wrapper', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  function makeFakeSessionCtx() {
    const store = new Map<string, unknown>()
    const session = {
      get: (k: string, def?: unknown) => (store.has(k) ? store.get(k) : def),
      put: (k: string, v: unknown) => store.set(k, v),
      forget: (k: string) => store.delete(k),
      has: (k: string) => store.has(k),
      pull: (k: string, def?: unknown) => {
        const v = store.has(k) ? store.get(k) : def
        store.delete(k)
        return v
      },
    }
    return { ctx: { session } as any, store, session }
  }

  test('namespaces every operation with the active tenant id', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })
    const { ctx, store } = makeFakeSessionCtx()

    await tenancy.run(fakeTenant('t1'), async () => {
      const s = tenantSession(ctx)
      s.put('cart', [1, 2, 3])
      assert.deepEqual(store.get('tenants/t1/cart'), [1, 2, 3])
      assert.deepEqual(s.get('cart'), [1, 2, 3])
      assert.isTrue(s.has('cart'))
      assert.deepEqual(s.pull('cart'), [1, 2, 3])
      assert.isFalse(s.has('cart'))
    })
  })

  test('parallel scopes do not collide on the same key name', async ({ assert }) => {
    const logCtx = new TenantLogContext()
    __configureTenancyForTests({ logCtx, registry: new BootstrapperRegistry() })
    const { ctx, store } = makeFakeSessionCtx()

    await Promise.all([
      tenancy.run(fakeTenant('a'), async () => {
        tenantSession(ctx).put('cart', 'a-cart')
      }),
      tenancy.run(fakeTenant('b'), async () => {
        tenantSession(ctx).put('cart', 'b-cart')
      }),
    ])

    assert.equal(store.get('tenants/a/cart'), 'a-cart')
    assert.equal(store.get('tenants/b/cart'), 'b-cart')
  })

  test('throws if ctx.session is missing', ({ assert }) => {
    assert.throws(() => tenantSession({} as any), /ctx\.session is not initialized/)
  })
})

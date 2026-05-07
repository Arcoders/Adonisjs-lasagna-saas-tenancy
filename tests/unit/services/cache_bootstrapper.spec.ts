import { test } from '@japa/runner'
import {
  createCacheBootstrapper,
  tenantCache,
  CACHE_NAMESPACE_PREFIX,
  __setNamespaceFactoryForTests,
} from '../../../src/services/bootstrappers/cache_bootstrapper.js'
import BootstrapperRegistry from '../../../src/services/bootstrapper_registry.js'
import { tenancy, __configureTenancyForTests } from '../../../src/tenancy.js'
import TenantLogContext from '../../../src/services/tenant_log_context.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id = 'tenant-1') =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

/**
 * Pure stub. We never want unit tests to open a Redis connection (that
 * keeps the event loop alive and hangs `npm run test`).
 */
function makeFakeFactory() {
  const calls: string[] = []
  const factory = (name: string) => {
    calls.push(name)
    return { __namespace: name } as any
  }
  return { factory, calls }
}

test.group('cacheBootstrapper — outside scope', (group) => {
  group.each.teardown(() => __setNamespaceFactoryForTests(undefined))

  test('tenantCache() throws outside a tenancy.run() scope', ({ assert }) => {
    const { factory } = makeFakeFactory()
    __setNamespaceFactoryForTests(factory)
    assert.throws(() => tenantCache(), /outside a tenancy\.run\(\) scope/)
  })

  test('createCacheBootstrapper returns the canonical name', ({ assert }) => {
    const { factory } = makeFakeFactory()
    const b = createCacheBootstrapper(factory)
    assert.equal(b.name, 'cache')
    assert.equal(CACHE_NAMESPACE_PREFIX, 'tenant_')
  })

  test('factory failure at enter surfaces immediately, not on tenantCache()', async ({
    assert,
  }) => {
    const boom = (_name: string) => {
      throw new Error('factory:boom')
    }
    const logCtx = new TenantLogContext()
    const registry = new BootstrapperRegistry()
    registry.register(createCacheBootstrapper(boom))
    __configureTenancyForTests({ logCtx, registry })

    await assert.rejects(
      () => tenancy.run(fakeTenant(), async () => {}),
      /factory:boom/
    )
    __configureTenancyForTests({})
  })
})

test.group('cacheBootstrapper — inside tenancy.run()', (group) => {
  group.each.teardown(() => {
    __configureTenancyForTests({})
    __setNamespaceFactoryForTests(undefined)
  })

  test('tenantCache() returns a namespace scoped to the active tenant', async ({
    assert,
  }) => {
    const { factory, calls } = makeFakeFactory()
    __setNamespaceFactoryForTests(factory)
    const logCtx = new TenantLogContext()
    const registry = new BootstrapperRegistry()
    registry.register(createCacheBootstrapper(factory))
    __configureTenancyForTests({ logCtx, registry })

    let observed: any
    await tenancy.run(fakeTenant('abc'), async () => {
      observed = tenantCache()
    })

    // enter() materializes once + tenantCache() re-derives once
    assert.deepEqual(calls, ['tenant_abc', 'tenant_abc'])
    assert.equal(observed.__namespace, 'tenant_abc')
  })

  test('tenantCache() throws after the scope exits', async ({ assert }) => {
    const { factory } = makeFakeFactory()
    __setNamespaceFactoryForTests(factory)
    const logCtx = new TenantLogContext()
    const registry = new BootstrapperRegistry()
    registry.register(createCacheBootstrapper(factory))
    __configureTenancyForTests({ logCtx, registry })

    await tenancy.run(fakeTenant('xyz'), async () => {
      assert.equal((tenantCache() as any).__namespace, 'tenant_xyz')
    })
    assert.throws(() => tenantCache(), /outside a tenancy\.run\(\) scope/)
  })

  test('parallel runs see independent namespaces', async ({ assert }) => {
    const { factory } = makeFakeFactory()
    __setNamespaceFactoryForTests(factory)
    const logCtx = new TenantLogContext()
    const registry = new BootstrapperRegistry()
    registry.register(createCacheBootstrapper(factory))
    __configureTenancyForTests({ logCtx, registry })

    const seen: string[] = []
    async function task(id: string) {
      await tenancy.run(fakeTenant(id), async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 5))
        seen.push((tenantCache() as any).__namespace)
      })
    }
    await Promise.all([task('alpha'), task('beta'), task('gamma')])
    assert.deepEqual(seen.sort(), ['tenant_alpha', 'tenant_beta', 'tenant_gamma'])
  })
})

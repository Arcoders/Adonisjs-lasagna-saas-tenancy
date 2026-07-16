import { test } from '@japa/runner'
import type { Queue, QueueOptions } from 'bullmq'
import type { ApplicationService } from '@adonisjs/core/types'
import { resetModuleCaches } from '../../../../src/providers/shutdown_caches.js'
import { closeOwnedHandles } from '../../../../src/providers/shutdown_handles.js'
import TenantQueueService from '../../../../src/services/tenant_queue_service.js'
import { tenancy, __configureTenancyForTests } from '../../../../src/tenancy.js'
import {
  getActiveDriver,
  __setActiveDriverRegistryForTests,
  __resetActiveDriverCache,
} from '../../../../src/services/isolation/active_driver.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import BootstrapperRegistry from '../../../../src/services/bootstrapper_registry.js'
import TenantLogContext from '../../../../src/services/tenant_log_context.js'
import {
  findTenantByIdCached,
  __setResolutionCacheForTests,
  __resetResolutionCacheRefForTests,
} from '../../../../src/extensions/request.js'
import TenantResolutionCache from '../../../../src/services/tenant_resolution_cache.js'
import { setupTestConfig } from '../../../helpers/config.js'
import { buildTestTenant } from '../../../../src/testing/builders.js'
import type { IsolationDriver } from '../../../../src/services/isolation/driver.js'
import type {
  TenantModelContract,
  TenantRepositoryContract,
} from '../../../../src/types/contracts.js'

/**
 * Backs security.md's "No singleton retention across boots":
 * `MultitenancyProvider.shutdown()` delegates to `resetModuleCaches()`,
 * which must drop the module-level references in `tenancy.ts` and
 * `active_driver.ts`. The provider class itself can't be imported in the
 * unit environment (its graph pulls a service that top-level-awaits app
 * boot), so the spec exercises the extracted function the provider calls.
 */
function fakeDriver(): IsolationDriver {
  return {
    name: 'schema-pg',
    contractVersion: 1,
    enforce: () => {},
    provision: async () => {},
    destroy: async () => {},
    reset: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    connectionName: (id: string) => `t_${id}`,
    tableLocation: (t: { id: string }) => ({
      kind: 'connection' as const,
      connectionName: `t_${t.id}`,
    }),
    migrate: async () => ({ executed: 0 }),
  } as unknown as IsolationDriver
}

/** Repo double that counts `findById` hits, so a cache miss is observable. */
function countingRepo() {
  let calls = 0
  const repo = {
    async findById(id: string): Promise<TenantModelContract | null> {
      calls += 1
      return { id } as unknown as TenantModelContract
    },
  } as unknown as TenantRepositoryContract
  return { repo, calls: () => calls }
}

test.group('provider shutdown — singleton cache invalidation', (group) => {
  group.each.setup(() => setupTestConfig())
  group.each.teardown(() => {
    __configureTenancyForTests({})
    __resetActiveDriverCache()
    __resetResolutionCacheRefForTests()
  })

  test('drops the cached isolation-driver registry', async ({ assert }) => {
    const registry = new IsolationDriverRegistry()
    registry.register(fakeDriver(), { activate: true })
    __setActiveDriverRegistryForTests(registry)

    const before = await getActiveDriver()
    assert.equal(before.name, 'schema-pg')

    await resetModuleCaches()

    // The stale registry must be gone: the next call has to re-resolve from
    // the (unavailable, in this unit env) container instead of reusing it.
    await assert.rejects(() => getActiveDriver())

    // And the seam accepts a fresh registry afterwards, proving the reset
    // left the module usable, not wedged.
    __setActiveDriverRegistryForTests(registry)
    assert.equal((await getActiveDriver()).name, 'schema-pg')
  })

  test('drops the cached tenancy singletons (log context + bootstrappers)', async ({ assert }) => {
    __configureTenancyForTests({
      logCtx: new TenantLogContext(),
      registry: new BootstrapperRegistry(),
    })
    const tenant = buildTestTenant()
    await tenancy.run(tenant, async () => {
      assert.equal(tenancy.currentId(), tenant.id)
    })

    await resetModuleCaches()

    // With the cached singletons invalidated, a new run() must re-resolve
    // from the container, which does not exist in this unit environment,
    // so holding on to the old instances would be the only way to "pass".
    await assert.rejects(() => tenancy.run(tenant, async () => {}))
    assert.isUndefined(tenancy.currentId())
  })

  test('drops the cached request resolution cache', async ({ assert }) => {
    setupTestConfig({ resolver: { cache: { enabled: true, ttlMs: 10_000 } } })
    __setResolutionCacheForTests(new TenantResolutionCache())

    const { repo, calls } = countingRepo()
    // Warm the cache: first lookup hits the repo, the second is served from it.
    await findTenantByIdCached(repo, 'tenant-1')
    await findTenantByIdCached(repo, 'tenant-1')
    assert.equal(calls(), 1)

    await resetModuleCaches()

    // The cached cache reference is gone, so the next lookup falls through to
    // the repo again (re-resolving the cache from the absent unit-env container
    // yields nothing). A retained reference would keep this at 1.
    await findTenantByIdCached(repo, 'tenant-1')
    assert.equal(calls(), 2)
  })
})

/** A stub BullMQ queue that records close(); stands in for a live ioredis handle. */
class FakeQueue {
  closed = false
  constructor(public readonly name: string) {}
  async close(): Promise<void> {
    this.closed = true
  }
}

/** Swaps the real BullMQ Queue for {@link FakeQueue} so shutdown can drain
 *  handles without a live Redis. */
class StubbedQueueService extends TenantQueueService {
  readonly created: FakeQueue[] = []
  #clock = 0
  protected override now(): number {
    return (this.#clock += 1)
  }
  protected override createQueue(name: string, _options: QueueOptions): Queue {
    const q = new FakeQueue(name)
    this.created.push(q)
    return q as unknown as Queue
  }
}

/**
 * Backs the clean-install smoke's SIGTERM fix: `MultitenancyProvider.shutdown()`
 * delegates to `closeOwnedHandles(app)`, which must resolve the singleton
 * `TenantQueueService` from the container and close every dispatch-path handle
 * it holds. The provider class itself can't be imported in the unit environment
 * (its graph top-level-awaits app boot), so the spec exercises the extracted
 * function against a fake container, mirroring the resetModuleCaches specs above.
 */
test.group('provider shutdown — owned-handle drain', (group) => {
  group.each.setup(() =>
    setupTestConfig({
      queue: {
        tenantQueuePrefix: 'tq_',
        defaultConcurrency: 1,
        attempts: 3,
        redis: { host: '127.0.0.1', port: 6379, db: 1 },
        maxOpenQueues: 100,
        queueIdleGraceMs: 30_000,
      },
    })
  )

  test('closeOwnedHandles resolves the queue singleton and drains it', async ({ assert }) => {
    const svc = new StubbedQueueService()
    // Simulate a worker that dispatched to two tenants: two persistent handles,
    // each owning an ioredis socket, are now open.
    svc.getOrCreate('tenant-a')
    svc.getOrCreate('tenant-b')
    assert.equal(svc.openHandleCount, 2)

    let requested: unknown
    const fakeApp = {
      container: {
        async make(token: unknown) {
          requested = token
          return svc
        },
      },
    } as unknown as ApplicationService

    await closeOwnedHandles(fakeApp)

    // It asked the container for exactly the queue singleton...
    assert.strictEqual(requested, TenantQueueService)
    // ...and drained every handle, so no ioredis socket keeps the loop alive.
    assert.equal(svc.openHandleCount, 0)
    assert.equal(svc.created.filter((q) => q.closed).length, 2)
  })
})

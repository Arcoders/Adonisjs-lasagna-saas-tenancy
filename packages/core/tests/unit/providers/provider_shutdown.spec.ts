import { test } from '@japa/runner'
import { resetModuleCaches } from '../../../src/providers/shutdown_caches.js'
import { tenancy, __configureTenancyForTests } from '../../../src/tenancy.js'
import {
  getActiveDriver,
  __setActiveDriverRegistryForTests,
  __resetActiveDriverCache,
} from '../../../src/services/isolation/active_driver.js'
import IsolationDriverRegistry from '../../../src/services/isolation/registry.js'
import BootstrapperRegistry from '../../../src/services/bootstrapper_registry.js'
import TenantLogContext from '../../../src/services/tenant_log_context.js'
import { setupTestConfig } from '../../helpers/config.js'
import { buildTestTenant } from '../../../src/testing/builders.js'
import type { IsolationDriver } from '../../../src/services/isolation/driver.js'

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
    provision: async () => {},
    destroy: async () => {},
    reset: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    connectionName: (id: string) => `t_${id}`,
    migrate: async () => ({ executed: 0 }),
  } as unknown as IsolationDriver
}

test.group('provider shutdown — singleton cache invalidation', (group) => {
  group.each.setup(() => setupTestConfig())
  group.each.teardown(() => {
    __configureTenancyForTests({})
    __resetActiveDriverCache()
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

    // And the seam accepts a fresh registry afterwards — proving the reset
    // left the module usable, not wedged.
    __setActiveDriverRegistryForTests(registry)
    assert.equal((await getActiveDriver()).name, 'schema-pg')
  })

  test('drops the cached tenancy singletons (log context + bootstrappers)', async ({
    assert,
  }) => {
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
    // from the container — which does not exist in this unit environment,
    // so holding on to the old instances would be the only way to "pass".
    await assert.rejects(() => tenancy.run(tenant, async () => {}))
    assert.isUndefined(tenancy.currentId())
  })
})

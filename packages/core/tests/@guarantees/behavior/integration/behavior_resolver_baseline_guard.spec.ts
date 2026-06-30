import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import MultitenancyProvider from '@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createResolverStateBaseline } from '@adonisjs-lasagna/saas-tenancy/internal'
import { createTestTenant, destroyTestTenant } from '../../../helpers/tenant.js'

/**
 * INTENTIONAL CHAOS FIXTURE. Do NOT "fix" the missing restore in the first group:
 * it deliberately re-boots the provider with a server-controlled strategy so the
 * shared `TenantResolverRegistry` chain is left pointing away from the header
 * resolver, and never restores it. This proves, end to end through the real Japa
 * lifecycle, that the test-kit's resolver-state baseline guard restores the boot
 * chain before the next group runs. Without that backstop the second group's
 * header-resolved request fails closed with a 400 (the exact cross-spec leak this
 * suite regressed on). A single warning from the guard naming the
 * "leaks the resolver chain" group is EXPECTED on every run; it is the guard
 * working.
 *
 * The two groups live in one file so they run back to back in definition order,
 * which makes the proof independent of the cross-file order: the guard's
 * `group:end` after the leak group must restore the chain before the assertion
 * group starts. The guard logic itself is unit-tested
 * (behavior_resolver_baseline.spec.ts and the kit's behavior_baseline_guard.spec.ts);
 * this proves the wiring.
 */
test.group('chaos: a group that leaks the resolver chain (intentional, do not fix)', (group) => {
  group.setup(async () => {
    // Re-boot with a server-controlled strategy: wireResolverChain rewires the
    // registry chain to ['subdomain'], and we deliberately never restore it.
    setConfig({ ...getConfig(), resolverStrategy: 'subdomain', resolverChain: undefined } as never)
    app.config.set('multitenancy', getConfig())
    await new MultitenancyProvider(app).boot()
  })

  test('the leaked chain points at the server-controlled resolver, not the header', async ({
    assert,
  }) => {
    const baseline = await createResolverStateBaseline(app)
    assert.deepEqual([...baseline.capture()], ['subdomain'])
  })
})

test.group('chaos: the next group resolves tenants from the header again', () => {
  test('a header-resolved active tenant is served — the guard restored the chain', async ({
    client,
  }) => {
    const tenant = await createTestTenant({ status: 'active' })
    try {
      const response = await client.get('/tenant/connection').header('x-tenant-id', tenant.id)
      response.assertStatus(200)
    } finally {
      await destroyTestTenant(tenant.id)
    }
  })
})

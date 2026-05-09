import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '../../helpers/config.js'
// Imported via the package path (build/) so we don't pull a parallel
// copy of `src/`. tsx will happily evaluate both copies of any module
// it can find, and a duplicate `extensions/request.ts` evaluation
// re-installs the `request.tenant()` macro under a SECOND closure that
// reads from a fresh `IsolationDriverRegistry` class — different class
// identity than the one the booted provider bound, so `getActiveDriver()`
// throws "no active driver" on the next request that hits the macro.
import MultitenancyProvider from '@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * `BillingService.verify()` is the boot-time guard against the most
 * common "wrong env" mistakes:
 *   - Test key paired with NODE_ENV=production → hard abort.
 *   - Live key in non-production env → hard abort unless
 *     STRIPE_ALLOW_LIVE_IN_DEV=true is set explicitly.
 *   - Misconfigured products → hard abort with the specific stripe id.
 *
 * The first group exercises `verify()` in isolation. The second group
 * exercises the SAME guard via `MultitenancyProvider.boot()` so a
 * regression that drops the boot-time invocation is caught (and not
 * just the implementation of `verify()` itself).
 */
test.group('BillingService.verify — mode + config validation', (group) => {
  const originalEnv = { ...process.env }
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(() => {
    originalConfig = getConfig()
  })

  group.each.teardown(async () => {
    process.env = { ...originalEnv }
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  function setBillingConfig(overrides: Partial<{
    apiKey: string
    webhookSecret: string
    products: Record<string, string>
    defaultPlan: string
    plansDefinitions: Record<string, { limits: Record<string, number> }>
  }>): void {
    setConfig({
      ...testConfig,
      plans: {
        defaultPlan: overrides.defaultPlan ?? 'starter',
        definitions: overrides.plansDefinitions ?? {
          starter: { limits: { apiRequests: 100 } },
          pro: { limits: { apiRequests: 10_000 } },
        },
      },
      billing: {
        driver: 'stripe',
        stripe: {
          apiKey: overrides.apiKey ?? 'sk_test_xxx',
          webhookSecret: overrides.webhookSecret ?? 'whsec_xxx',
        },
        products: overrides.products ?? { prod_pro: 'pro' },
        defaultPlan: overrides.defaultPlan ?? 'starter',
      },
    } as MultitenancyConfig)
  }

  test('aborts boot when sk_test_* paired with NODE_ENV=production', async ({ assert }) => {
    process.env.NODE_ENV = 'production'
    setBillingConfig({ apiKey: 'sk_test_abort_me' })

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    await assert.rejects(
      () => billing.verify(),
      /test key but NODE_ENV=production/
    )
  })

  test('aborts boot when sk_live_* paired with NODE_ENV != production (no escape hatch)', async ({
    assert,
  }) => {
    process.env.NODE_ENV = 'development'
    delete process.env.STRIPE_ALLOW_LIVE_IN_DEV
    setBillingConfig({ apiKey: 'sk_live_abort_me' })

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    await assert.rejects(
      () => billing.verify(),
      /LIVE key but NODE_ENV is not "production"/
    )
  })

  test('STRIPE_ALLOW_LIVE_IN_DEV=true permits sk_live_* outside production', async ({
    assert,
  }) => {
    process.env.NODE_ENV = 'development'
    process.env.STRIPE_ALLOW_LIVE_IN_DEV = 'true'
    setBillingConfig({ apiKey: 'sk_live_intentional' })

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    // Should not reject — the escape hatch is the operator's explicit
    // opt-in for staging environments that legitimately use live keys.
    await billing.verify()
    assert.isTrue(true)
  })

  test('aborts boot when defaultPlan is not declared in plans.definitions', async ({ assert }) => {
    process.env.NODE_ENV = 'test'
    setBillingConfig({
      defaultPlan: 'enterprise', // not declared
      plansDefinitions: { starter: { limits: {} } },
    })

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    await assert.rejects(
      () => billing.verify(),
      /defaultPlan "enterprise" is not declared/
    )
  })

  test('aborts boot when a product mapping points at an undeclared plan', async ({ assert }) => {
    process.env.NODE_ENV = 'test'
    setBillingConfig({
      products: { prod_pro: 'pro', prod_phantom: 'phantom_plan' },
      plansDefinitions: {
        starter: { limits: {} },
        pro: { limits: {} },
        // phantom_plan deliberately missing
      },
    })

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    await assert.rejects(
      () => billing.verify(),
      /products\["prod_phantom"\] = "phantom_plan"/
    )
  })

  test('verify is idempotent — calling twice is a no-op', async ({ assert }) => {
    process.env.NODE_ENV = 'test'
    setBillingConfig({ apiKey: 'sk_test_xxx' })

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    await billing.verify()
    await billing.verify() // must not throw on second call

    assert.isTrue(true) // no throw = pass
  })

  test('verify is a no-op when config.billing is absent', async ({ assert }) => {
    setConfig({ ...testConfig } as MultitenancyConfig) // no `billing` key

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    await billing.verify() // should resolve silently
    assert.isTrue(true)
  })
})

/**
 * Lifecycle integration: the guard above is only useful if `provider.boot()`
 * actually invokes it. A regression that removes the call would leave
 * `verify()` itself working but boot would silently accept misconfig.
 *
 * We instantiate a fresh `MultitenancyProvider`, swap the app's config to
 * a mode-mismatched billing block, and observe that `boot()` rejects.
 */
test.group('MultitenancyProvider.boot — billing.verify wiring', (group) => {
  const originalEnv = { ...process.env }
  let originalConfig: ReturnType<typeof getConfig>
  let originalAdonisConfig: unknown

  group.each.setup(() => {
    originalConfig = getConfig()
    originalAdonisConfig = app.config.get('multitenancy')
  })

  group.each.teardown(async () => {
    process.env = { ...originalEnv }
    setConfig(originalConfig)
    app.config.set('multitenancy', originalAdonisConfig)
    const billing = await app.container.make(BillingService)
    billing.__resetForTests()
  })

  test("provider.boot() refuses to start when verify rejects", async ({ assert }) => {
    process.env.NODE_ENV = 'production'

    const evilConfig: MultitenancyConfig = {
      ...testConfig,
      plans: {
        defaultPlan: 'starter',
        definitions: { starter: { limits: {} } },
      },
      billing: {
        driver: 'stripe',
        stripe: {
          apiKey: 'sk_test_will_be_rejected_in_production',
          webhookSecret: 'whsec_xxx',
        },
        products: { prod_starter: 'starter' },
        defaultPlan: 'starter',
      },
    } as MultitenancyConfig

    // Adonis providers read `app.config`, not the package-level `setConfig`
    // — so we have to update both for boot() to see the bad config.
    app.config.set('multitenancy', evilConfig)
    setConfig(evilConfig)

    const provider = new MultitenancyProvider(app as never)
    // Do NOT call `provider.register()` here — the singletons are
    // already bound on the global container from the suite-level boot.
    // Re-registering would replace the live `HookRegistry` /
    // `IsolationDriverRegistry` / `BillingService` instances (the
    // singleton resolver gets a fresh `enqueue()` wrapper, so the
    // *next* `container.make(...)` returns a freshly-constructed
    // instance, not the one the suite booted). The
    // `tenant_delete_lifecycle` spec's auto-wired before:destroy hook
    // lives on the originally-bound `HookRegistry` — replacing it
    // silently drops the hook.

    const billing = await app.container.make(BillingService)
    billing.__resetForTests()

    await assert.rejects(
      () => provider.boot(),
      /test key but NODE_ENV=production/
    )
  })
})

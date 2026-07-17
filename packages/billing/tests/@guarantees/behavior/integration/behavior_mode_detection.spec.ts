import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '@adonisjs-lasagna/satellite-test-kit/testing'
// Imported via the package path (build/) so we don't pull a parallel copy of
// the satellite's `src/`. tsx will evaluate both copies of any module it can
// resolve, and a duplicate model/service evaluation yields a second class
// identity than the one the booted provider bound. Billing's boot-time guard
// lives in the billing provider (the core never imports billing), so this is
// the provider whose boot() must invoke verify().
import BillingProvider from '@adonisjs-lasagna/billing/provider'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * `BillingService.verify()` is the boot-time guard against the most
 * common "wrong env" mistakes:
 *   - Test key paired with NODE_ENV=production: a hard abort.
 *   - Live key in non-production env: a hard abort unless
 *     STRIPE_ALLOW_LIVE_IN_DEV=true is set explicitly.
 *   - Misconfigured products: a hard abort with the specific stripe id.
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
    await billing.__resetForTests()
  })

  function setBillingConfig(
    overrides: Partial<{
      apiKey: string
      webhookSecret: string
      products: Record<string, string>
      defaultPlan: string
      plansDefinitions: Record<string, { limits: Record<string, number> }>
    }>
  ): void {
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
    // Configure while still in the (non-production) test env, THEN flip to
    // production: setConfig refuses a second set under NODE_ENV=production
    // (config immutability), and verify() reads NODE_ENV at call time anyway.
    setBillingConfig({ apiKey: 'sk_test_abort_me' })
    process.env.NODE_ENV = 'production'

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    await assert.rejects(() => billing.verify(), /test key but NODE_ENV=production/)
  })

  test('aborts boot when sk_live_* paired with NODE_ENV != production (no escape hatch)', async ({
    assert,
  }) => {
    process.env.NODE_ENV = 'development'
    delete process.env.STRIPE_ALLOW_LIVE_IN_DEV
    setBillingConfig({ apiKey: 'sk_live_abort_me' })

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    await assert.rejects(() => billing.verify(), /LIVE key but NODE_ENV is not "production"/)
  })

  test('STRIPE_ALLOW_LIVE_IN_DEV=true permits sk_live_* outside production', async ({ assert }) => {
    process.env.NODE_ENV = 'development'
    process.env.STRIPE_ALLOW_LIVE_IN_DEV = 'true'
    setBillingConfig({ apiKey: 'sk_live_intentional' })

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    // The escape hatch is the operator's explicit opt-in for staging
    // environments that legitimately use live keys: verify must NOT reject.
    // NOTE: no 2nd argument. @japa/assert treats a string there as an
    // error-MESSAGE MATCHER ("must not reject with this message"), which would
    // let any other rejection pass silently.
    await assert.doesNotReject(() => billing.verify())
  })

  test('aborts boot when webhookSecret is empty', async ({ assert }) => {
    process.env.NODE_ENV = 'test'
    setBillingConfig({ webhookSecret: '' })

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    await assert.rejects(() => billing.verify(), /webhookSecret is empty/)
  })

  test('aborts boot when webhookSecret does not start with whsec_ prefix', async ({ assert }) => {
    process.env.NODE_ENV = 'test'
    // Common operator mistake: pasting STRIPE_API_KEY into the secret slot.
    setBillingConfig({ webhookSecret: 'sk_test_pasted_into_wrong_env_var' })

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    await assert.rejects(() => billing.verify(), /does not start with "whsec_"/)
  })

  test('aborts boot when defaultPlan is not declared in plans.definitions', async ({ assert }) => {
    process.env.NODE_ENV = 'test'
    setBillingConfig({
      defaultPlan: 'enterprise', // not declared
      plansDefinitions: { starter: { limits: {} } },
    })

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    await assert.rejects(() => billing.verify(), /defaultPlan "enterprise" is not declared/)
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
    await billing.__resetForTests()

    await assert.rejects(() => billing.verify(), /products\["prod_phantom"\] = "phantom_plan"/)
  })

  test('verify is idempotent — calling twice is a no-op', async ({ assert }) => {
    process.env.NODE_ENV = 'test'
    setBillingConfig({ apiKey: 'sk_test_xxx' })

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    await billing.verify()
    // A second verify() must be a no-op. (No 2nd arg: a string there is an
    // error-message matcher, not a label, which would mask real rejections.)
    await assert.doesNotReject(() => billing.verify())
  })

  test('verify is a no-op when config.billing is absent', async ({ assert }) => {
    setConfig({ ...testConfig } as MultitenancyConfig) // no `billing` key

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    // verify() must resolve silently when config.billing is absent. (No 2nd
    // arg: a string there is an error-message matcher, not a label.)
    await assert.doesNotReject(() => billing.verify())
  })
})

/**
 * Lifecycle integration: the guard above is only useful if `provider.boot()`
 * actually invokes it. A regression that removes the call would leave
 * `verify()` itself working but boot would silently accept misconfig.
 *
 * Since the satellite extraction the boot-time invocation lives in the
 * billing provider (the core provider never imports billing). We instantiate a
 * fresh `BillingProvider`, swap the app's config to a mode-mismatched billing
 * block, and observe that `boot()` rejects.
 */
test.group('BillingProvider.boot — billing.verify wiring', (group) => {
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
    await billing.__resetForTests()
  })

  test('provider.boot() refuses to start when verify rejects', async ({ assert }) => {
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

    // Adonis providers read `app.config`, not the package-level `setConfig`,
    // so we have to update both for boot() to see the bad config.
    app.config.set('multitenancy', evilConfig)
    setConfig(evilConfig)
    // Flip to production AFTER setConfig: the config-immutability guard refuses
    // a second setConfig under production, and provider.boot() calls verify(),
    // which reads NODE_ENV at call time.
    process.env.NODE_ENV = 'production'

    const provider = new BillingProvider(app as never)
    // Do NOT call `provider.register()` here. BillingProvider.register() binds
    // the `BillingService` singleton, which the suite-level boot already bound;
    // re-registering swaps it for a freshly constructed instance, so the
    // `__resetForTests()` below (and the bad config we just set) would apply to a
    // different object than the one `provider.boot()` resolves and verifies.

    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()

    // The definePlugin facade wraps a boot-hook throw in a PluginBootException
    // attributed to { plugin, phase } (fail-closed, aborting the deploy); the
    // original verify() reason is carried as its `cause`.
    let bootError: unknown
    try {
      // `boot` is optional on the erased SatelliteProviderContract this public
      // export resolves to, but definePlugin always synthesizes it.
      await provider.boot!()
    } catch (error) {
      bootError = error
    }
    assert.exists(
      bootError,
      'boot() must reject when a test key is paired with NODE_ENV=production'
    )
    const reason =
      ((bootError as { cause?: Error })?.cause?.message ?? (bootError as Error)?.message) || ''
    assert.match(reason, /test key but NODE_ENV=production/)
  })
})

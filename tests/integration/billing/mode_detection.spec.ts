import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { BillingService } from '@adonisjs-lasagna/saas-tenancy/services'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { testConfig } from '../../helpers/config.js'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * `BillingService.verify()` is the boot-time guard against the most
 * common "wrong env" mistakes:
 *   - Test key paired with NODE_ENV=production → hard abort.
 *   - Live key in non-production env → loud warn unless
 *     STRIPE_ALLOW_LIVE_IN_DEV=true is set.
 *   - Misconfigured products → hard abort with the specific stripe id.
 *
 * Rather than mock the SDK, we just verify the validation paths — they
 * fire BEFORE the SDK is constructed (or after a successful import).
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
          webhookSecret: 'whsec_xxx',
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

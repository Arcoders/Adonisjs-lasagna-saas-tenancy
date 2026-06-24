import { test } from '@japa/runner'
import BillingDriverRegistry from '../../src/services/billing/billing_driver_registry.js'
import { BILLING_CONTRACT_VERSION } from '../../src/constants.js'
import type { BillingProviderContract } from '../../src/contracts/billing_provider_contract.js'

const driver = (name: string, contractVersion: number | undefined = BILLING_CONTRACT_VERSION) =>
  ({ name, contractVersion }) as unknown as BillingProviderContract

test.group('BillingDriverRegistry', () => {
  test('first registered driver becomes active by default', ({ assert }) => {
    const r = new BillingDriverRegistry()
    r.register(driver('stripe'))
    assert.equal(r.active().name, 'stripe')
    assert.deepEqual([...r.list()], ['stripe'])
  })

  test('activate flag and use() switch the active driver', ({ assert }) => {
    const r = new BillingDriverRegistry()
    r.register(driver('stripe'))
    r.register(driver('paddle'), { activate: true })
    assert.equal(r.active().name, 'paddle')
    r.use('stripe')
    assert.equal(r.active().name, 'stripe')
    assert.isTrue(r.has('paddle'))
    assert.equal(r.get('paddle')?.name, 'paddle')
  })

  test('use() throws for an unregistered driver', ({ assert }) => {
    const r = new BillingDriverRegistry()
    r.register(driver('stripe'))
    assert.throws(() => r.use('nope'), /not registered/)
  })

  test('active() throws when nothing is registered, and clear() empties', ({ assert }) => {
    const r = new BillingDriverRegistry()
    assert.throws(() => r.active(), /no active driver/)
    r.register(driver('stripe'))
    r.clear()
    assert.deepEqual([...r.list()], [])
    assert.throws(() => r.active(), /no active driver/)
  })
})

test.group('BillingDriverRegistry — contractVersion compatibility', () => {
  test('a driver built for a NEWER contract is rejected at registration', ({ assert }) => {
    const r = new BillingDriverRegistry()
    assert.throws(
      () => r.register(driver('future', BILLING_CONTRACT_VERSION + 1)),
      /requires extension contract/
    )
    assert.isFalse(r.has('future'))
  })

  test('a driver matching the contract registers', ({ assert }) => {
    const r = new BillingDriverRegistry()
    r.register(driver('stripe', BILLING_CONTRACT_VERSION))
    assert.isTrue(r.has('stripe'))
  })

  test('the built-in drivers all declare the current contract version', async ({ assert }) => {
    const { default: StripeDriver } = await import('../../src/drivers/stripe/stripe_driver.js')
    const { default: PaddleDriver } = await import('../../src/drivers/paddle/paddle_driver.js')
    const { default: LemonSqueezyDriver } =
      await import('../../src/drivers/lemon_squeezy/lemon_squeezy_driver.js')
    const { default: MockBillingDriver } = await import('../../src/testing/mock_billing_driver.js')
    for (const D of [StripeDriver, PaddleDriver, LemonSqueezyDriver]) {
      assert.equal((new D() as BillingProviderContract).contractVersion, BILLING_CONTRACT_VERSION)
    }
    assert.equal(new MockBillingDriver().contractVersion, BILLING_CONTRACT_VERSION)
  })
})

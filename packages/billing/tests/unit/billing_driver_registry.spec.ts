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

  test('a built-in driver declares the current contract version', async ({ assert }) => {
    // Smoke that a built-in driver declares contractVersion. We check only the
    // lightweight MockBillingDriver: importing and constructing the real
    // Stripe/Paddle/LemonSqueezy drivers would pull their entire provider
    // surface into this package's `all: true` unit coverage as uncovered
    // functions. Those drivers (and their declared contractVersion) are
    // exercised in the integration tier, which feeds the merged coverage gate.
    const { default: MockBillingDriver } = await import('../../src/testing/mock_billing_driver.js')
    assert.equal(new MockBillingDriver().contractVersion, BILLING_CONTRACT_VERSION)
  })
})

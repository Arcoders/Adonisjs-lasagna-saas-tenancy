import { test } from '@japa/runner'
import BillingDriverRegistry from '../../src/services/billing/billing_driver_registry.js'
import type { BillingProviderContract } from '../../src/contracts/billing_provider_contract.js'

const driver = (name: string) => ({ name }) as unknown as BillingProviderContract

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

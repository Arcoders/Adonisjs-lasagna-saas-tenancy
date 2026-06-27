import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import ace from '@adonisjs/core/services/ace'
import { BillingService } from '@adonisjs-lasagna/billing'
import { MockStripe } from '@adonisjs-lasagna/billing'
import { ProcessBillingEventJob } from '@adonisjs-lasagna/billing'
import { BillingProcessedEvent } from '@adonisjs-lasagna/billing'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { setupBillingConfig, clearBillingTables } from './helpers.js'

// Execution coverage for the two billing diagnostics commands (doctor +
// test-webhook). Stripe is MockStripe; ProcessBillingEventJob.dispatch is
// stubbed so the controller's enqueue doesn't need a live worker.
test.group('tenant:billing:doctor + tenant:billing:test-webhook (integration)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>
  let originalDispatch: typeof ProcessBillingEventJob.dispatch

  group.each.setup(async () => {
    originalConfig = getConfig()
    setupBillingConfig({ defaultPlan: 'starter' })
    await clearBillingTables()
    const billing = await app.container.make(BillingService)
    await billing.__setStripeForTests(new MockStripe('whsec_test_billing_helper'))
    originalDispatch = ProcessBillingEventJob.dispatch
    ;(ProcessBillingEventJob as unknown as { dispatch: () => Promise<void> }).dispatch =
      async () => {}
  })

  group.each.teardown(async () => {
    ;(ProcessBillingEventJob as unknown as { dispatch: typeof originalDispatch }).dispatch =
      originalDispatch
    await clearBillingTables()
    setConfig(originalConfig)
    const billing = await app.container.make(BillingService)
    await billing.__resetForTests()
  })

  test('tenant:billing:doctor exits 0 when every check passes', async ({ assert }) => {
    const cmd = await ace.exec('tenant:billing:doctor', ['--json'])
    assert.equal(cmd.exitCode, 0, 'doctor exits 0 with a healthy billing config + reachable Stripe')
  })

  test('tenant:billing:doctor exits 1 when config.billing is missing', async ({ assert }) => {
    setConfig({ ...getConfig(), billing: undefined } as never)
    const cmd = await ace.exec('tenant:billing:doctor', [])
    assert.equal(cmd.exitCode, 1, 'doctor exits non-zero when the billing satellite is inactive')
  })

  test('tenant:billing:test-webhook POSTs a signed event and the ledger records it', async ({
    assert,
  }) => {
    const eventType = 'customer.subscription.created'
    const port = process.env.PORT ?? '3333'
    const cmd = await ace.exec('tenant:billing:test-webhook', [
      eventType,
      '--url',
      `http://127.0.0.1:${port}/webhooks/billing`,
    ])
    assert.equal(cmd.exitCode, 0, 'the webhook route returned 2xx for the synthetic event')

    const rows = await BillingProcessedEvent.query().where('eventType', eventType)
    assert.isAtLeast(
      rows.length,
      1,
      'the synthetic event was written to the processed-events ledger'
    )
    assert.match(rows[0].eventId, /^evt_test_/)
  })
})

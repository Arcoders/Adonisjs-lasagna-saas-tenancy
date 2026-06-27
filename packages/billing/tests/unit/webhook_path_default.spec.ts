import { test } from '@japa/runner'
import { resolveBillingWebhookPath } from '../../src/webhook_path.js'

/**
 * WS-7 / billing-config-stripe-specific-defaults-in-neutral-block.
 *
 * `@adonisjs-lasagna/billing` is provider-neutral (Stripe, Paddle, Lemon
 * Squeezy), but the webhook default was the Stripe-branded `/webhooks/stripe`.
 * The neutral default is `/webhooks/billing`; an explicit option or
 * `config.billing.webhook.path` still wins.
 *
 * RED (pre-fix): the default was `/webhooks/stripe`.
 */
test.group('resolveBillingWebhookPath', () => {
  test('defaults to the provider-neutral /webhooks/billing', ({ assert }) => {
    assert.equal(resolveBillingWebhookPath({}), '/webhooks/billing')
    assert.equal(resolveBillingWebhookPath({}, undefined), '/webhooks/billing')
    assert.equal(resolveBillingWebhookPath({}, { webhook: {} }), '/webhooks/billing')
  })

  test('config.billing.webhook.path overrides the default', ({ assert }) => {
    assert.equal(resolveBillingWebhookPath({}, { webhook: { path: '/hooks/x' } }), '/hooks/x')
  })

  test('an explicit option wins over config and default', ({ assert }) => {
    assert.equal(
      resolveBillingWebhookPath({ path: '/explicit' }, { webhook: { path: '/hooks/x' } }),
      '/explicit'
    )
  })

  test('the default carries no Stripe branding', ({ assert }) => {
    assert.notInclude(resolveBillingWebhookPath({}), 'stripe')
  })
})

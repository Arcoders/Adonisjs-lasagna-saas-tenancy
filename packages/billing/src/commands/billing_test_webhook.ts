import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { signWebhookPayload } from '../testing/sign_webhook_payload.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { safeFetch } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { getActiveBillingDriver } from '../services/billing/active_billing_driver.js'
import { DEFAULT_STRIPE_API_VERSION } from '../stripe_api_version.js'

const TEMPLATES: Record<string, () => Record<string, unknown>> = {
  'customer.subscription.created': () => ({
    id: `sub_test_${Date.now()}`,
    object: 'subscription',
    status: 'active',
    customer: 'cus_test_replace_me',
    items: { data: [{ price: { product: 'prod_replace_me' } }] },
    current_period_start: Math.floor(Date.now() / 1000),
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
  }),
  'customer.subscription.deleted': () => ({
    id: `sub_test_${Date.now()}`,
    object: 'subscription',
    status: 'canceled',
    customer: 'cus_test_replace_me',
    items: { data: [{ price: { product: 'prod_replace_me' } }] },
    current_period_start: Math.floor(Date.now() / 1000) - 30 * 86400,
    current_period_end: Math.floor(Date.now() / 1000),
  }),
  'invoice.payment_failed': () => ({
    id: `in_test_${Date.now()}`,
    object: 'invoice',
    customer: 'cus_test_replace_me',
    amount_due: 1000,
    currency: 'usd',
    attempt_count: 1,
  }),
}

/**
 * Generate and POST a signed synthetic Stripe event to the local webhook.
 * Invaluable in CI / debugging — exercises the full middleware → controller
 * → job pipeline without going through `stripe listen`.
 *
 *   node ace tenant:billing:test-webhook customer.subscription.created
 *
 * The body is built from a known template; replace `cus_test_replace_me`
 * and `prod_replace_me` with real IDs from your Stripe test mode for an
 * end-to-end run.
 */
export default class BillingTestWebhook extends BaseCommand {
  static readonly commandName = 'tenant:billing:test-webhook'
  static readonly description = 'Generate and POST a signed synthetic Stripe event'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Event type (e.g. customer.subscription.created)' })
  declare event: string

  @flags.string({
    flagName: 'url',
    default: 'http://127.0.0.1:3333/webhooks/billing',
    description: 'Webhook URL (override host/port if needed)',
  })
  declare url: string

  @flags.string({
    flagName: 'object',
    description: 'Optional JSON file path with the event.data.object body',
  })
  declare object?: string

  async run() {
    const cfg = getConfig().billing
    if (!cfg) {
      this.logger.error('config.billing not set')
      this.exitCode = 1
      return
    }

    const driver = await getActiveBillingDriver()
    if (driver.name !== 'stripe' || !cfg.stripe) {
      this.logger.error(
        `tenant:billing:test-webhook currently supports only the Stripe driver (active: "${driver.name}")`
      )
      this.exitCode = 1
      return
    }

    const factory = TEMPLATES[this.event]
    let dataObject: Record<string, unknown>
    if (this.object) {
      const { readFile } = await import('node:fs/promises')
      dataObject = JSON.parse(await readFile(this.object, 'utf8'))
    } else if (factory) {
      dataObject = factory()
    } else {
      this.logger.error(
        `No template for "${this.event}". Pass --object=path/to/body.json or pick from: ${Object.keys(TEMPLATES).join(', ')}`
      )
      this.exitCode = 1
      return
    }

    const event = {
      id: `evt_test_${Date.now()}`,
      object: 'event',
      type: this.event,
      api_version: cfg.stripe.apiVersion ?? DEFAULT_STRIPE_API_VERSION,
      created: Math.floor(Date.now() / 1000),
      data: { object: dataObject },
      livemode: false,
      pending_webhooks: 1,
    }

    const body = JSON.stringify(event)
    const sig = signWebhookPayload(body, cfg.stripe.webhookSecret)

    // The target is user-supplied (--url), so route it through pinned safeFetch:
    // a non-loopback host is resolved, range-validated, and pinned. The default
    // target is a loopback dev listener, which is allowed without pinning.
    const res = await safeFetch(this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'stripe-signature': sig },
      body,
      allowLoopback: true,
    })

    const text = await res.text()
    this.logger.log(`POST ${this.url}  →  ${res.status}`)
    if (text) this.logger.log(text.slice(0, 500))
    this.exitCode = res.ok ? 0 : 1
  }
}

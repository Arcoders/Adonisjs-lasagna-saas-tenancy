import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import BillingService from '../services/billing_service.js'
import StripeSubscription from '../models/satellites/stripe_subscription.js'
import StripeCustomer from '../models/satellites/stripe_customer.js'

/**
 * Reconcile drift between Stripe and our local mirror. Run as a daily cron
 * to recover from missed webhooks (Stripe outages, queue backlog).
 *
 * Idempotent: re-applying the same Stripe state via `syncSubscription` is
 * a no-op (the ordering guard handles redelivery; same plan = no quota
 * cache bust).
 */
export default class BillingSync extends BaseCommand {
  static readonly commandName = 'tenant:billing:sync'
  static readonly description =
    'Reconcile Stripe subscriptions with the local mirror — recovers from missed webhooks'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({ flagName: 'dry-run', default: false, description: 'Report drift without writing' })
  declare dryRun: boolean

  @flags.string({
    flagName: 'tenant',
    description: 'Reconcile a single tenant (uuid). Default: all tenants.',
  })
  declare tenant?: string

  @flags.string({
    flagName: 'since',
    description: 'ISO8601 timestamp; only consider subscriptions created after',
  })
  declare since?: string

  @flags.boolean({ flagName: 'json', default: false, description: 'Emit JSON summary' })
  declare json: boolean

  async run() {
    const billing = await app.container.make(BillingService)
    const stripe = await billing.getClient()

    let scanned = 0
    let drifted = 0
    let repaired = 0
    const errors: Array<{ subscription_id: string; error: string }> = []

    let customerFilter: string | undefined
    if (this.tenant) {
      const c = await StripeCustomer.find(this.tenant)
      if (!c) {
        this.logger.error(`No Stripe customer for tenant ${this.tenant}`)
        this.exitCode = 1
        return
      }
      customerFilter = c.stripeCustomerId
    }

    const params: Record<string, unknown> = { status: 'all', limit: 100 }
    if (customerFilter) params.customer = customerFilter
    if (this.since) {
      const ts = Date.parse(this.since)
      if (!Number.isFinite(ts)) {
        this.logger.error(`--since must be ISO8601, got "${this.since}"`)
        this.exitCode = 1
        return
      }
      params.created = { gte: Math.floor(ts / 1000) }
    }

    // Stripe's list methods return an auto-paginating async iterator
    // when used with `for await`. The cast widens the typed `params` for
    // the SDK's discriminated union without dropping field validation
    // (we already validated `since` above and Stripe ignores extras).
    const subs = stripe.subscriptions.list(
      params as Parameters<typeof stripe.subscriptions.list>[0]
    )
    for await (const sub of subs) {
      scanned += 1
      const local = await StripeSubscription.find(sub.id)
      const localStatus = local?.status
      const remoteStatus = sub.status
      const isDrift = !local || localStatus !== remoteStatus

      if (!isDrift) continue
      drifted += 1

      if (this.dryRun) {
        this.logger.warning(
          `drift  ${sub.id}  ${localStatus ?? '(missing)'} → ${remoteStatus}`
        )
        continue
      }

      try {
        // The sync uses the event's `created` timestamp for the ordering
        // guard. For a manual reconcile, pass `now` so we always overwrite
        // (this is the operator's explicit "I trust Stripe" signal).
        await billing.syncSubscription(sub, Math.floor(Date.now() / 1000), {
          downgrade: remoteStatus === 'canceled',
        })
        repaired += 1
        this.logger.success(
          `repaired  ${sub.id}  ${localStatus ?? '(missing)'} → ${remoteStatus}`
        )
      } catch (err) {
        const message = (err as Error)?.message ?? 'unknown error'
        errors.push({ subscription_id: sub.id, error: message })
        this.logger.error(`failed   ${sub.id}: ${message}`)
      }
    }

    const summary = { scanned, drifted, repaired, errors }
    if (this.json) {
      this.logger.log(JSON.stringify(summary, null, 2))
    } else {
      this.logger.log('')
      this.logger.log(
        `${this.colors.bold('summary')}  scanned=${scanned}  drifted=${drifted}  repaired=${repaired}  errors=${errors.length}`
      )
    }
    this.exitCode = errors.length > 0 ? 1 : 0
  }
}

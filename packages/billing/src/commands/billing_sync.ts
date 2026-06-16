import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import type Stripe from 'stripe'
import BillingService from '../services/billing_service.js'
import BillingSubscription from '../models/satellites/billing_subscription.js'
import BillingCustomer from '../models/satellites/billing_customer.js'
import { getActiveBillingDriver } from '../services/billing/active_billing_driver.js'
import { toSubscription } from '../drivers/stripe/stripe_mapper.js'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
import { QuotaService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'

/**
 * Reconcile drift between the provider and our local mirror. Run as a daily
 * cron to recover from missed webhooks (provider outages, queue backlog).
 *
 * Reconciliation pulls the provider's full subscription list, which is a
 * provider-specific operation — this command currently supports the **Stripe**
 * driver. (Paddle / Lemon Squeezy reconcile commands are a fast follow-up.)
 *
 * Idempotent: re-applying the same remote state via `syncSubscription` is a
 * no-op (the ordering guard handles redelivery; same plan = no quota bust).
 */
export default class BillingSync extends BaseCommand {
  static readonly commandName = 'tenant:billing:sync'
  static readonly description =
    'Reconcile provider subscriptions with the local mirror — recovers from missed webhooks (Stripe driver)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({
    flagName: 'dry-run',
    default: false,
    description: 'Report drift without writing',
  })
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
    const driver = await getActiveBillingDriver()
    if (driver.name !== 'stripe') {
      this.logger.warning(
        `tenant:billing:sync currently supports only the Stripe driver (active: "${driver.name}"). Skipping.`
      )
      return
    }

    const billing = await app.container.make(BillingService)
    const stripe = (await billing.getClient()) as Stripe

    let scanned = 0
    let drifted = 0
    let repaired = 0
    const errors: Array<{ subscription_id: string; error: string }> = []

    let customerFilter: string | undefined
    if (this.tenant) {
      const c = await BillingCustomer.find(this.tenant)
      if (!c) {
        this.logger.error(`No billing customer for tenant ${this.tenant}`)
        this.exitCode = 1
        return
      }
      customerFilter = c.providerCustomerId
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

    const subs = stripe.subscriptions.list(
      params as Parameters<typeof stripe.subscriptions.list>[0]
    )
    for await (const sub of subs) {
      scanned += 1
      const neutral = toSubscription(sub)
      const local = await BillingSubscription.find(neutral.providerSubscriptionId)
      const localStatus = local?.status
      const remoteStatus = neutral.status
      const isDrift = !local || localStatus !== remoteStatus

      if (!isDrift) continue
      drifted += 1

      if (this.dryRun) {
        this.logger.warning(
          `drift  ${neutral.providerSubscriptionId}  ${localStatus ?? '(missing)'} → ${remoteStatus}`
        )
        continue
      }

      try {
        // For a manual reconcile, pass `now` for the ordering guard so we always
        // overwrite (the operator's explicit "I trust the provider" signal).
        await billing.syncSubscription(neutral, Math.floor(Date.now() / 1000), {
          downgrade: remoteStatus === 'canceled',
        })
        repaired += 1
        this.logger.success(
          `repaired  ${neutral.providerSubscriptionId}  ${localStatus ?? '(missing)'} → ${remoteStatus}`
        )
      } catch (err) {
        const message = (err as Error)?.message ?? 'unknown error'
        errors.push({ subscription_id: neutral.providerSubscriptionId, error: message })
        this.logger.error(`failed   ${neutral.providerSubscriptionId}: ${message}`)
      }
    }

    // Reverse pass — tenants whose tenant_plans claims a provider-priced plan
    // but whose local mirror has no active subscription (a missed
    // `subscription.deleted`, a manual row delete, or a migrated plan row).
    // Recovery is to downgrade them back to defaultPlan.
    const cfg = getConfig().billing
    const defaultPlan = cfg?.defaultPlan
    let orphanedPlans = 0
    let orphansRepaired = 0
    if (defaultPlan) {
      const ACTIVE_STATUSES = ['active', 'trialing', 'past_due', 'paused', 'unpaid']
      const orphanQuery = TenantPlan.query()
        .where('source', driver.name)
        .whereNot('planName', defaultPlan)
      if (this.tenant) orphanQuery.where('tenantId', this.tenant)
      const planRows = await orphanQuery
      for (const row of planRows) {
        const liveSub = await BillingSubscription.query()
          .where('tenantId', row.tenantId)
          .whereIn('status', ACTIVE_STATUSES)
          .first()
        if (liveSub) continue
        orphanedPlans += 1
        if (this.dryRun) {
          this.logger.warning(
            `orphan ${row.tenantId} plan=${row.planName} (source=${driver.name}, no active subscription)`
          )
          continue
        }
        try {
          const quotas = new QuotaService()
          await quotas.assignPlan(row.tenantId, defaultPlan, { source: 'reconciliation' })
          orphansRepaired += 1
          this.logger.success(`orphan-repaired ${row.tenantId}  ${row.planName} → ${defaultPlan}`)
        } catch (err) {
          const message = (err as Error)?.message ?? 'unknown error'
          errors.push({ subscription_id: `tenant:${row.tenantId}`, error: message })
          this.logger.error(`orphan-failed ${row.tenantId}: ${message}`)
        }
      }
    }

    const summary = { scanned, drifted, repaired, orphanedPlans, orphansRepaired, errors }
    if (this.json) {
      this.logger.log(JSON.stringify(summary, null, 2))
    } else {
      this.logger.log('')
      this.logger.log(
        `${this.colors.bold('summary')}  scanned=${scanned}  drifted=${drifted}  repaired=${repaired}  orphanedPlans=${orphanedPlans}  orphansRepaired=${orphansRepaired}  errors=${errors.length}`
      )
    }
    this.exitCode = errors.length > 0 ? 1 : 0
  }
}

import { Job } from '@adonisjs/queue'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import BillingSubscription from '../models/satellites/billing_subscription.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import {
  applyDunningDowngrade,
  dispatchTrialEnding,
} from '../services/billing/billing_event_dispatcher.js'

/**
 * Periodic billing sweep. Reused by the queue job AND the `tenant:billing:sweep`
 * ace command. Provider-agnostic and idempotent: each unit of work clears the
 * row from its own query (stamp the trial flag / clear the downgrade timestamp),
 * so concurrent or repeated runs never double-act.
 *
 * Two responsibilities, both time-driven and not tied to a webhook:
 *
 *   1. Trial-ending notices. Stripe fires a native `trial_will_end` webhook, but
 *      Paddle and Lemon Squeezy don't. This synthesises the notice from the
 *      mirror's `trial_end` for every provider, deduped against the same
 *      `trial_ending_notified_at` flag the native handler stamps, so each
 *      subscription is notified exactly once regardless of provider.
 *
 *   2. Grace-period dunning downgrades. When `dunning.gracePeriodDays > 0`, the
 *      payment-failed handler schedules the downgrade via `dunning_downgrade_at`
 *      instead of applying it immediately; this applies the ones now due.
 */
export async function runBillingSweep(opts: { batchSize?: number } = {}): Promise<{
  trialNotices: number
  downgrades: number
}> {
  const cfg = getConfig().billing
  if (!cfg) return { trialNotices: 0, downgrades: 0 }

  const batchSize = opts.batchSize ?? 500
  const now = DateTime.utc()

  // 1. Trial-ending notices.
  const leadDays = cfg.trialEndingLeadDays ?? 3
  const trialCutoff = now.plus({ days: leadDays })
  let trialNotices = 0
  while (true) {
    const due = await BillingSubscription.query()
      .where('status', 'trialing')
      .whereNotNull('tenantId')
      .whereNotNull('trialEnd')
      .where('trialEnd', '<=', trialCutoff.toSQL()!)
      .whereNull('trialEndingNotifiedAt')
      .orderBy('trialEnd', 'asc')
      .limit(batchSize)

    if (due.length === 0) break

    for (const sub of due) {
      await dispatchTrialEnding(
        sub.tenantId!,
        sub.providerSubscriptionId,
        sub.trialEnd?.toSeconds() ?? null
      )
      sub.trialEndingNotifiedAt = DateTime.utc()
      await sub.save()
      trialNotices += 1
    }
    if (due.length < batchSize) break
  }

  // 2. Grace-period dunning downgrades.
  let downgrades = 0
  if (cfg.defaultPlan) {
    while (true) {
      const due = await BillingSubscription.query()
        .whereNotNull('dunningDowngradeAt')
        .where('dunningDowngradeAt', '<=', now.toSQL()!)
        .whereIn('status', ['past_due', 'unpaid'])
        .whereNotNull('tenantId')
        .limit(batchSize)

      if (due.length === 0) break

      for (const sub of due) {
        await applyDunningDowngrade(sub.tenantId!, cfg.defaultPlan, logger)
        sub.dunningDowngradeAt = null
        await sub.save()
        downgrades += 1
      }
      if (due.length < batchSize) break
    }
  }

  logger.info({ trial_notices: trialNotices, downgrades }, 'billing.sweep.completed')
  return { trialNotices, downgrades }
}

/**
 * Queue job wrapper around `runBillingSweep`. Idempotent and safe to run on a cron
 * via the `tenant:billing:sweep` command (hourly is suggested). Each run sends
 * provider-agnostic trial-ending notices and applies grace-period dunning
 * downgrades that have come due, so a tenant is never notified or downgraded twice.
 */
export default class BillingSweepJob extends Job<{ batchSize?: number }> {
  static options = { name: 'lasagna.BillingSweepJob' }

  async execute(): Promise<void> {
    await runBillingSweep(this.payload ?? {})
  }
}

import { Job } from '@adonisjs/queue'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import StripeProcessedEvent from '../models/satellites/stripe_processed_event.js'
import { getConfig } from '../config.js'

/**
 * Core cleanup routine. Reused by the queue job AND the `billing_cleanup`
 * ace command — keeping the logic outside `Job.execute()` lets the
 * command instantiate it directly without the `payload` setter dance.
 *
 * Idempotent: runs in batches and re-queries each loop, so concurrent
 * runs of the same retention sweep never delete the same row twice.
 */
export async function runBillingCleanup(opts: { batchSize?: number } = {}): Promise<{
  deleted: number
  cutoff: string
}> {
  const cfg = getConfig().billing
  const ttlDays = cfg?.webhook?.idempotencyTtlDays ?? 90
  const cutoff = DateTime.utc().minus({ days: ttlDays })
  const batchSize = opts.batchSize ?? 1000

  let totalDeleted = 0
  while (true) {
    const ids = await StripeProcessedEvent.query()
      .where('status', 'completed')
      .where('processedAt', '<', cutoff.toSQL()!)
      .limit(batchSize)
      .select('eventId')

    if (ids.length === 0) break

    await StripeProcessedEvent.query()
      .whereIn(
        'eventId',
        ids.map((r) => r.eventId)
      )
      .delete()
    totalDeleted += ids.length
    if (ids.length < batchSize) break
  }

  logger.info({ deleted: totalDeleted, cutoff: cutoff.toISO() }, 'billing.cleanup.completed')
  return { deleted: totalDeleted, cutoff: cutoff.toISO()! }
}

/**
 * Purges `stripe_processed_events` rows whose `status='completed'` and
 * `processed_at` is older than the configured retention window
 * (default 90 days — matches Stripe's max retry window, so older events
 * can never legitimately be re-delivered).
 *
 * Idempotent. Safe to run on a daily cron via `tenant:billing:cleanup`.
 */
export default class BillingCleanupJob extends Job<{ batchSize?: number }> {
  async execute(): Promise<void> {
    await runBillingCleanup(this.payload ?? {})
  }
}

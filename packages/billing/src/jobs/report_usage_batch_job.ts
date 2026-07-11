import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import BillingUsageEvent from '../models/satellites/billing_usage_event.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { resolveTenantRepository } from '@adonisjs-lasagna/saas-tenancy/services'
import BillingService from '../services/billing_service.js'

interface ReportUsageBatchPayload {
  tenantId: string
  meterEventName: string
  quantity: number
  /**
   * Stable, unique-per-flush idempotency key sealed by the dispatching listener.
   * The job uses it verbatim and never recomputes one from wall-clock, so each
   * flush is counted once and a retry of the same batch is deduped. Optional only
   * so a job enqueued by an older build mid-deploy still runs (it falls back to
   * the legacy minute bucket).
   */
  idempotencyKey?: string
}

/**
 * Flush a single batched (tenant, meter, total quantity) record to Stripe.
 * Used by the auto-bridge listener that aggregates `QuotaTracked` events
 * in memory and dispatches to this job every `batchFlushMs` (default 10s).
 *
 * Why a queue job (not inline): tracking can run in hot request paths;
 * even a fast Stripe call (~80ms) would spike p99 if we synchronously
 * reported every flush. The queue absorbs the latency, and BullMQ's
 * retry policy + our DB idempotency_key makes double-reports impossible.
 *
 * Note: the heavy usage-mapping logic (which quotas map to which meters) lives
 * in the listener, not here. This job is the dumb pipe.
 */
export default class ReportUsageBatchJob extends Job<ReportUsageBatchPayload> {
  static options = { name: 'lasagna.ReportUsageBatchJob' }

  async execute(): Promise<void> {
    const { tenantId, meterEventName, quantity } = this.payload
    if (quantity <= 0) return

    const cfg = getConfig().billing
    if (!cfg) {
      logger.warn(
        { tenant_id: tenantId, meter_event_name: meterEventName },
        'billing.report_usage.config_missing: dropping batch'
      )
      return
    }

    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(tenantId)
    if (!tenant) {
      logger.warn(
        { tenant_id: tenantId, meter_event_name: meterEventName },
        'billing.report_usage.tenant_missing: dropping batch'
      )
      return
    }

    const billing = await app.container.make(BillingService)
    await billing.reportUsage(tenant, { eventName: meterEventName }, quantity, {
      // Use the key the listener sealed at dispatch. It's unique per flush (so
      // every batch counts) yet stable across retries of this same job (so a
      // retry is deduped, not double-counted). Don't recompute it from wall-clock.
      // The fallback only fires for a job enqueued by an older build still in the
      // queue across a rolling deploy.
      idempotencyKey:
        this.payload.idempotencyKey ?? `${tenantId}:${meterEventName}:${this.#minuteBucket()}`,
    })
  }

  async failed(error: Error): Promise<void> {
    // The DB row in `billing_usage_events` already records the failure.
    // We just emit a metric/log so ops sees the rate. No dead-letter event
    // for metering; loss of a single batch isn't worth paging on.
    logger.error(
      {
        tenant_id: this.payload?.tenantId,
        meter_event_name: this.payload?.meterEventName,
        error: error.message,
      },
      'billing.report_usage.failed'
    )
    // Update the audit row so the doctor surfaces the error.
    try {
      const failed = await BillingUsageEvent.query()
        .where('tenantId', this.payload.tenantId)
        .where('meterEventName', this.payload.meterEventName)
        .where('status', 'pending')
        .orderBy('createdAt', 'desc')
        .first()
      if (failed) {
        failed.status = 'failed'
        failed.lastError = error.message?.slice(0, 500) ?? 'unknown error'
        await failed.save()
      }
    } catch {
      /* swallow, best effort */
    }
  }

  #minuteBucket(): number {
    return Math.floor(Date.now() / 60_000)
  }
}

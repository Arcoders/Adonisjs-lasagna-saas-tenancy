import logger from '@adonisjs/core/services/logger'
import type { QuotaTracked } from '@adonisjs-lasagna/saas-tenancy/events'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import ReportUsageBatchJob from '../jobs/report_usage_batch_job.js'

interface BatchKey {
  tenantId: string
  meterEventName: string
}

const DEFAULT_FLUSH_MS = 10_000

/**
 * In-memory aggregator: accumulates `QuotaTracked` events per
 * (tenant, meter) and flushes a single `ReportUsageBatchJob` per bucket
 * every `batchFlushMs` (default 10s).
 *
 * Why batched: on a high-traffic tenant, `track` may fire 1000s of times/s
 * — synchronously hitting Stripe's meter API would saturate rate limits
 * within seconds. Aggregating in-memory and flushing per bucket keeps us
 * comfortably below the 100-events/s default.
 *
 * Why in-memory (not Redis): the worst-case loss on a process crash is
 * one bucket's worth (~10s) of usage data. The DB row in
 * `stripe_meter_events` lands ONLY after the flush succeeds, so we never
 * "report and lose audit" — we either lose both or persist both. For
 * higher durability needs, a v1.1 enhancement would buffer to a Redis
 * sorted-set that workers atomically drain.
 *
 * Flush is also triggered on `provider.shutdown()` so a clean SIGTERM
 * doesn't lose the current in-flight bucket.
 */
export default class UsageAutoBridgeListener {
  #pending = new Map<string, { tenantId: string; meterEventName: string; quantity: number }>()
  #timers = new Map<string, NodeJS.Timeout>()

  async handle(event: QuotaTracked): Promise<void> {
    const cfg = getConfig().billing
    if (!cfg?.usageMapping) return
    const mapping = cfg.usageMapping[event.quota]
    if (!mapping) return

    const key = this.#bucketKey({ tenantId: event.tenant.id, meterEventName: mapping.meterEventName })
    const existing = this.#pending.get(key)
    if (existing) {
      existing.quantity += event.amount
    } else {
      this.#pending.set(key, {
        tenantId: event.tenant.id,
        meterEventName: mapping.meterEventName,
        quantity: event.amount,
      })
      // Schedule the flush. If a timer already exists for this key
      // (rare race), do not replace it — it'll flush on its existing
      // schedule and pick up everything we just accumulated.
      const flushMs = mapping.batchFlushMs ?? DEFAULT_FLUSH_MS
      const timer = setTimeout(() => this.flush(key), flushMs)
      // unref so a pending timer never holds the event loop open during
      // graceful shutdown; the explicit flush in shutdown() handles drain.
      timer.unref?.()
      this.#timers.set(key, timer)
    }
  }

  /** Flush a single bucket. Public so the provider can drain on shutdown. */
  async flush(key: string): Promise<void> {
    const bucket = this.#pending.get(key)
    if (!bucket) return
    this.#pending.delete(key)
    const timer = this.#timers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.#timers.delete(key)
    }

    if (bucket.quantity <= 0) return

    try {
      await ReportUsageBatchJob.dispatch({
        tenantId: bucket.tenantId,
        meterEventName: bucket.meterEventName,
        quantity: bucket.quantity,
      })
    } catch (err) {
      logger.error(
        {
          tenant_id: bucket.tenantId,
          meter_event_name: bucket.meterEventName,
          quantity: bucket.quantity,
          err: (err as Error)?.message,
        },
        'billing.usage_bridge.dispatch_failed: bucket dropped (aggregate of N tracks lost)'
      )
    }
  }

  /** Drain every pending bucket. Called from `provider.shutdown()`. */
  async drainAll(): Promise<void> {
    const keys = [...this.#pending.keys()]
    await Promise.all(keys.map((k) => this.flush(k)))
  }

  #bucketKey(k: BatchKey): string {
    return `${k.tenantId}::${k.meterEventName}`
  }
}

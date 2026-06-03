import type { ApplicationService } from '@adonisjs/core/types'
import logger from '@adonisjs/core/services/logger'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantQuotaExceeded, QuotaTracked } from '@adonisjs-lasagna/saas-tenancy/events'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import BillingService from '../src/services/billing_service.js'
import UsageAutoBridgeListener from '../src/listeners/usage_auto_bridge_listener.js'
import QuotaExceededBillingListener from '../src/listeners/quota_exceeded_billing_listener.js'
import TenantDestroyBillingListener from '../src/listeners/tenant_destroy_billing_listener.js'
import ProcessStripeEventJob from '../src/jobs/process_stripe_event_job.js'
import BillingCleanupJob from '../src/jobs/billing_cleanup_job.js'
import ReportUsageBatchJob from '../src/jobs/report_usage_batch_job.js'

/**
 * Provider for `@adonisjs-lasagna/billing`. Register it in `adonisrc.ts`
 * alongside the core `MultitenancyProvider`. It does what the core provider
 * used to do for billing — but inverted, so the core never imports billing:
 *
 *  - `register()`  — bind `BillingService` + `UsageAutoBridgeListener` singletons.
 *  - `boot()`      — validate the Stripe config eagerly (fail at boot, not at
 *                    the first webhook).
 *  - `start()`     — register the billing jobs with the @adonisjs/queue Locator
 *                    and subscribe the quota / usage / tenant-delete listeners
 *                    to core events + lifecycle hooks.
 *  - `shutdown()`  — drain the in-memory metering aggregator.
 */
export default class BillingProvider {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(BillingService, () => new BillingService())
    this.app.container.singleton(UsageAutoBridgeListener, () => new UsageAutoBridgeListener())
  }

  async boot() {
    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    // Validate billing config + Stripe SDK availability eagerly, so a missing
    // peer dep / wrong-mode key blows up at boot instead of at the first
    // webhook (where the failure manifests as a 500 in front of Stripe's
    // retry tier).
    if (config?.billing) {
      const billing = await this.app.container.make(BillingService)
      await billing.verify()
    }
  }

  async start() {
    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    if (!config?.billing) return

    await this.#registerBillingJobs()
    await this.#wireBillingListeners(config)
  }

  // Register the billing jobs with @adonisjs/queue's Locator. The core
  // provider auto-registers only the core jobs (its `jobs/index` no longer
  // re-exports billing), so without this dispatched ProcessStripeEventJob /
  // BillingCleanupJob / ReportUsageBatchJob dead-letter at the worker.
  async #registerBillingJobs(): Promise<void> {
    try {
      const { Locator } = await import('@adonisjs/queue')
      for (const JobClass of [ProcessStripeEventJob, BillingCleanupJob, ReportUsageBatchJob]) {
        const J = JobClass as unknown as { name: string; options?: { name?: string } }
        Locator.register(J.options?.name ?? J.name, JobClass as never)
      }
    } catch (error) {
      logger.warn(
        { err: (error as Error)?.message },
        '[billing] could not auto-register billing jobs with the @adonisjs/queue Locator'
      )
    }
  }

  /**
   * Subscribe billing-side listeners to package events + tenant-lifecycle
   * hooks. The emitter is resolved lazily so the package never hard-depends on
   * `@adonisjs/core/services/emitter` outside an Adonis app (some test setups
   * boot a stripped-down container).
   */
  async #wireBillingListeners(config: MultitenancyConfig): Promise<void> {
    const emitter = await import('@adonisjs/core/services/emitter')
      .then((m) => m.default)
      .catch(() => null)

    if (emitter && config.billing?.notifyOnQuotaExceeded) {
      emitter.on(TenantQuotaExceeded, async (event) => {
        const listener = new QuotaExceededBillingListener()
        await listener.handle(event)
      })
    }

    if (
      emitter &&
      config.billing?.usageMapping &&
      Object.keys(config.billing.usageMapping).length > 0
    ) {
      const listener = await this.app.container.make(UsageAutoBridgeListener)
      emitter.on(QuotaTracked, async (event) => {
        await listener.handle(event)
      })
    }

    // Tenant hard-delete cleanup. Always wired when billing is configured —
    // there's no reason to leave a Stripe subscription billing the platform
    // for a tenant that no longer exists. The listener honours
    // `config.billing.onTenantDelete` for the policy choice.
    const hooks = await this.app.container.make(HookRegistry)
    hooks.before('destroy', async (ctx) => {
      const listener = new TenantDestroyBillingListener()
      await listener.handle(ctx.tenant)
    })
  }

  async shutdown() {
    // Drain the in-memory metering aggregator — losing buckets here would
    // silently under-report usage to Stripe. Only drain when the listener is
    // actually wired (config.usageMapping present).
    try {
      const config = this.app.config.get<MultitenancyConfig>('multitenancy')
      if (config?.billing?.usageMapping) {
        const listener = await this.app.container.make(UsageAutoBridgeListener)
        await listener.drainAll()
      }
    } catch {
      // Best-effort drain — never block shutdown on a metering hiccup.
    }
  }
}

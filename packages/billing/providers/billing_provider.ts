import type { ApplicationService } from '@adonisjs/core/types'
import logger from '@adonisjs/core/services/logger'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import { TenantQuotaExceeded, QuotaTracked } from '@adonisjs-lasagna/saas-tenancy/events'
import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import type {
  SatelliteProviderConstructor,
  SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import BillingService from '../src/services/billing_service.js'
import BillingDriverRegistry from '../src/services/billing/billing_driver_registry.js'
import type { BillingProviderContract } from '../src/contracts/billing_provider_contract.js'
import UsageAutoBridgeListener from '../src/listeners/usage_auto_bridge_listener.js'
import QuotaExceededBillingListener from '../src/listeners/quota_exceeded_billing_listener.js'
import TenantDestroyBillingListener from '../src/listeners/tenant_destroy_billing_listener.js'
import SuspendOnPaymentFailureListener from '../src/listeners/suspend_on_payment_failure_listener.js'
import ReactivateOnPaymentSuccessListener from '../src/listeners/reactivate_on_payment_success_listener.js'
import PaymentFailed from '../src/events/billing/payment_failed.js'
import SubscriptionCanceled from '../src/events/billing/subscription_canceled.js'
import PaymentSucceeded from '../src/events/billing/payment_succeeded.js'
import ProcessBillingEventJob from '../src/jobs/process_billing_event_job.js'
import BillingCleanupJob from '../src/jobs/billing_cleanup_job.js'
import BillingSweepJob from '../src/jobs/billing_sweep_job.js'
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
export default class BillingProvider implements SatelliteProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    this.app.container.singleton(BillingDriverRegistry, () => new BillingDriverRegistry())
    this.app.container.singleton(BillingService, () => new BillingService())
    this.app.container.singleton(UsageAutoBridgeListener, () => new UsageAutoBridgeListener())
  }

  async boot() {
    const config = this.app.config.get<MultitenancyConfig>('multitenancy')
    if (!config?.billing) return

    // Seed the active driver from config.billing.driver, then validate eagerly
    // so a missing peer dep / wrong-mode key / malformed secret blows up at
    // boot instead of at the first webhook (a 500 in front of the provider's
    // retry tier).
    const registry = await this.app.container.make(BillingDriverRegistry)
    const choice = config.billing.driver ?? 'stripe'
    if (!registry.has(choice)) {
      registry.register(await this.#instantiateDriver(choice), { activate: true })
    } else {
      registry.use(choice)
    }

    const billing = await this.app.container.make(BillingService)
    await billing.verify()
  }

  /**
   * Construct a built-in driver by name. Custom drivers are registered by the
   * host app on `BillingDriverRegistry` before boot, so they're already present
   * (the `registry.has(choice)` guard skips this path for them).
   */
  async #instantiateDriver(choice: string): Promise<BillingProviderContract> {
    switch (choice) {
      case 'stripe': {
        const { default: StripeDriver } = await import('../src/drivers/stripe/stripe_driver.js')
        return new StripeDriver()
      }
      case 'paddle': {
        const { default: PaddleDriver } = await import('../src/drivers/paddle/paddle_driver.js')
        return new PaddleDriver()
      }
      case 'lemonsqueezy': {
        const { default: LemonSqueezyDriver } =
          await import('../src/drivers/lemon_squeezy/lemon_squeezy_driver.js')
        return new LemonSqueezyDriver()
      }
      default:
        throw new Error(
          `[billing] unknown driver "${choice}". Register a custom driver on ` +
            `BillingDriverRegistry before boot, or use 'stripe' | 'paddle' | 'lemonsqueezy'.`
        )
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
      for (const JobClass of [
        ProcessBillingEventJob,
        BillingCleanupJob,
        BillingSweepJob,
        ReportUsageBatchJob,
      ]) {
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

    // Opt-in: suspend a tenant on a terminal payment failure / dunning-failed
    // cancellation. Wired only when `config.billing.suspendOnPaymentFailure`.
    if (emitter && config.billing?.suspendOnPaymentFailure) {
      const suspendListener = new SuspendOnPaymentFailureListener()
      emitter.on(PaymentFailed, async (event) => {
        await suspendListener.handlePaymentFailed(event)
      })
      emitter.on(SubscriptionCanceled, async (event) => {
        await suspendListener.handleSubscriptionCanceled(event)
      })

      // Companion reactivation, wired only when BOTH flags are on.
      if (config.billing?.reactivateOnPaymentSuccess) {
        const reactivateListener = new ReactivateOnPaymentSuccessListener()
        emitter.on(PaymentSucceeded, async (event) => {
          await reactivateListener.handle(event)
        })
      }
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

// Compile-time ABI pin: this provider's constructor AND instance must stay
// assignable to the published Satellite contract. Any lifecycle-signature drift
// fails `tsc` here (and at the `implements` clause), so a first-party provider
// can never silently diverge from the ABI third-party satellites build against.
// Runtime effect: a harmless no-op module-local, evaluated once at boot.
const _satelliteAbiPin: SatelliteProviderConstructor = BillingProvider

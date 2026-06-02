import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import BillingService from '../services/billing_service.js'
import StripeProcessedEvent from '../models/satellites/stripe_processed_event.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'

interface CheckResult {
  name: string
  status: 'ok' | 'warn' | 'error'
  message: string
}

/**
 * Quick sanity check across the billing wiring. Exits non-zero on any
 * `error`. Designed to slot into deploy pipelines:
 *   `node ace tenant:billing:doctor || exit 1`.
 *
 * Distinct from `tenant:doctor` (the package-wide doctor) — this one
 * focuses purely on billing surfaces and stays cheap to run.
 */
export default class BillingDoctor extends BaseCommand {
  static readonly commandName = 'tenant:billing:doctor'
  static readonly description = 'Diagnose Stripe billing config + recent webhook health'
  static readonly options: CommandOptions = { startApp: true }

  @flags.boolean({ flagName: 'json', default: false, description: 'Emit JSON' })
  declare json: boolean

  async run() {
    const results: CheckResult[] = []

    const cfg = getConfig().billing
    if (!cfg) {
      results.push({
        name: 'config.billing',
        status: 'error',
        message: 'config.billing is not set — billing satellite is inactive',
      })
      this.#emit(results)
      this.exitCode = 1
      return
    }

    // 1. Webhook secret format (we never check the value, only that it's there).
    if (!cfg.stripe.webhookSecret) {
      results.push({
        name: 'webhook_secret',
        status: 'error',
        message: 'config.billing.stripe.webhookSecret is empty',
      })
    } else if (!cfg.stripe.webhookSecret.startsWith('whsec_')) {
      results.push({
        name: 'webhook_secret',
        status: 'warn',
        message: 'webhook secret does not start with `whsec_` — likely wrong env var',
      })
    } else {
      results.push({ name: 'webhook_secret', status: 'ok', message: 'present' })
    }

    // 2. Default plan + product mappings declared.
    const plansCfg = getConfig().plans
    if (plansCfg && !plansCfg.definitions[cfg.defaultPlan]) {
      results.push({
        name: 'default_plan',
        status: 'error',
        message: `config.billing.defaultPlan "${cfg.defaultPlan}" not in plans.definitions`,
      })
    } else {
      results.push({ name: 'default_plan', status: 'ok', message: cfg.defaultPlan })
    }

    let unmapped = 0
    for (const [stripeId, planName] of Object.entries(cfg.products)) {
      if (plansCfg && !plansCfg.definitions[planName]) {
        unmapped += 1
        results.push({
          name: 'product_mapping',
          status: 'error',
          message: `products["${stripeId}"] = "${planName}" not in plans.definitions`,
        })
      }
    }
    if (unmapped === 0) {
      results.push({
        name: 'product_mapping',
        status: 'ok',
        message: `${Object.keys(cfg.products).length} products mapped`,
      })
    }

    // 3. Stripe API reachable + key valid.
    try {
      const billing = await app.container.make(BillingService)
      const stripe = await billing.getClient()
      await stripe.balance.retrieve()
      results.push({ name: 'stripe_api', status: 'ok', message: 'balance.retrieve OK' })
    } catch (err) {
      results.push({
        name: 'stripe_api',
        status: 'error',
        message: `Stripe API unreachable or key invalid: ${(err as Error)?.message}`,
      })
    }

    // 4. No old failed events (>24h).
    try {
      const cutoff = DateTime.utc().minus({ hours: 24 })
      const stale = await StripeProcessedEvent.query()
        .where('status', 'failed')
        .where('processedAt', '<', cutoff.toSQL()!)
        .count('* as total')
      const total = Number((stale[0] as any).$extras?.total ?? (stale[0] as any).total ?? 0)
      if (total > 0) {
        results.push({
          name: 'failed_events',
          status: 'warn',
          message: `${total} event(s) in status=failed older than 24h — try \`tenant:billing:replay --all-failed\` after the fix`,
        })
      } else {
        results.push({ name: 'failed_events', status: 'ok', message: '0 stale failures' })
      }
    } catch (err) {
      results.push({
        name: 'failed_events',
        status: 'warn',
        message: `query failed: ${(err as Error)?.message}`,
      })
    }

    this.#emit(results)
    this.exitCode = results.some((r) => r.status === 'error') ? 1 : 0
  }

  #emit(results: CheckResult[]) {
    if (this.json) {
      this.logger.log(JSON.stringify({ checks: results }, null, 2))
      return
    }
    for (const r of results) {
      const tag =
        r.status === 'ok'
          ? this.colors.green('OK')
          : r.status === 'warn'
            ? this.colors.yellow('WARN')
            : this.colors.red('ERR')
      this.logger.log(`${tag}  ${this.colors.bold(r.name)}  ${r.message}`)
    }
  }
}

export type { CheckResult }

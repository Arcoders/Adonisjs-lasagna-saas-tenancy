import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { DateTime } from 'luxon'
import BillingProcessedEvent from '../models/satellites/billing_processed_event.js'
import { getActiveBillingDriver } from '../services/billing/active_billing_driver.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'

interface CheckResult {
  name: string
  status: 'ok' | 'warn' | 'error'
  message: string
}

/**
 * Quick sanity check across the billing wiring. Exits non-zero on any `error`.
 * Designed to slot into deploy pipelines:
 *   `node ace tenant:billing:doctor || exit 1`.
 *
 * Provider-agnostic: validates the active driver's config + reachability plus
 * the driver-neutral plan mappings and recent webhook health.
 */
export default class BillingDoctor extends BaseCommand {
  static readonly commandName = 'tenant:billing:doctor'
  static readonly description = 'Diagnose billing config + recent webhook health'
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

    const driver = await getActiveBillingDriver()

    // 1. Driver config (key mode, secret shape — provider-specific checks).
    try {
      await driver.verifyConfig()
      results.push({ name: 'driver_config', status: 'ok', message: `${driver.name} config valid` })
    } catch (err) {
      results.push({
        name: 'driver_config',
        status: 'error',
        message: `${driver.name} config invalid: ${(err as Error)?.message}`,
      })
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
    for (const [productId, planName] of Object.entries(cfg.products)) {
      if (plansCfg && !plansCfg.definitions[planName]) {
        unmapped += 1
        results.push({
          name: 'product_mapping',
          status: 'error',
          message: `products["${productId}"] = "${planName}" not in plans.definitions`,
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

    // 3. Provider API reachable (when the driver exposes a probe).
    if (driver.healthCheck) {
      try {
        await driver.healthCheck()
        results.push({ name: 'provider_api', status: 'ok', message: `${driver.name} API OK` })
      } catch (err) {
        results.push({
          name: 'provider_api',
          status: 'error',
          message: `${driver.name} API unreachable or key invalid: ${(err as Error)?.message}`,
        })
      }
    } else {
      results.push({
        name: 'provider_api',
        status: 'ok',
        message: `${driver.name} driver has no health probe — skipped`,
      })
    }

    // 4. Drift-recovery (forward pass) coverage for the active driver.
    if (driver.supports('subscription_list')) {
      results.push({
        name: 'reconciliation',
        status: 'ok',
        message: `${driver.name} supports subscription listing — \`tenant:billing:sync\` forward pass available`,
      })
    } else {
      results.push({
        name: 'reconciliation',
        status: 'warn',
        message: `${driver.name} driver has no 'subscription_list' capability — \`tenant:billing:sync\` forward drift-recovery (provider → mirror) is unavailable; only the reverse pass (orphaned plans) runs`,
      })
    }

    // 5. No old failed events (>24h).
    try {
      const cutoff = DateTime.utc().minus({ hours: 24 })
      // backoffice-scope-exempt: doctor reconciliation counts stale failed events across ALL tenants (a fleet-wide health check, not a tenant-scoped read).
      const stale = await BillingProcessedEvent.query()
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

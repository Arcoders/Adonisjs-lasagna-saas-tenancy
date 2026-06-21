import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { DateTime } from 'luxon'
import { getActiveBillingDriver } from '../services/billing/active_billing_driver.js'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { TenantPlan } from '@adonisjs-lasagna/saas-tenancy/models/satellites'

interface CheckResult {
  name: string
  status: 'ok' | 'warn' | 'error'
  message: string
}

/**
 * Validate the billing pricing configuration before a deploy. Designed as a CI
 * gate:  `node ace tenant:billing:pricing:validate || exit 1`.
 *
 * Hard errors (exit 1): a product mapped to an undefined plan, a `defaultPlan`
 * that isn't defined, an active tenant entitled to a plan that no longer exists,
 * or an unreachable / invalid provider key. Provider price resolution is a
 * best-effort warning: `config.billing.products` keys are usually product ids,
 * which the price-lookup endpoint can't resolve, so a non-resolving key warns
 * (it may be a product id, or a deleted price) rather than failing the gate.
 * Drivers without the `price_lookup` capability (Lemon Squeezy) warn once.
 */
export default class BillingPricingValidate extends BaseCommand {
  static readonly commandName = 'tenant:billing:pricing:validate'
  static readonly description =
    'Validate billing plan/price configuration — CI-friendly (exit 1 on error)'
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

    const plansCfg = getConfig().plans
    const definitions = plansCfg?.definitions ?? {}

    // 1. defaultPlan is defined.
    if (!definitions[cfg.defaultPlan]) {
      results.push({
        name: 'default_plan',
        status: 'error',
        message: `config.billing.defaultPlan "${cfg.defaultPlan}" not in plans.definitions`,
      })
    } else {
      results.push({ name: 'default_plan', status: 'ok', message: cfg.defaultPlan })
    }

    // 2. Every mapped plan resolves to a definition.
    let unmapped = 0
    for (const [productId, planName] of Object.entries(cfg.products)) {
      if (!definitions[planName]) {
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
        message: `${Object.keys(cfg.products).length} product mappings resolve`,
      })
    }

    // 3. No active tenant is entitled to a plan that no longer exists.
    try {
      const nowSql = DateTime.utc().toSQL()!
      const activeRows = await TenantPlan.query().where((sub) => {
        sub.whereNull('expiresAt').orWhere('expiresAt', '>', nowSql)
      })
      const activePlanNames = [...new Set(activeRows.map((r) => r.planName))]
      const stranded = activePlanNames.filter((p) => !definitions[p])
      if (stranded.length > 0) {
        for (const p of stranded) {
          results.push({
            name: 'active_tenant_plans',
            status: 'error',
            message: `active tenants are on plan "${p}" which is not in plans.definitions`,
          })
        }
      } else {
        results.push({
          name: 'active_tenant_plans',
          status: 'ok',
          message: `${activePlanNames.length} distinct active plan(s), all defined`,
        })
      }
    } catch (err) {
      results.push({
        name: 'active_tenant_plans',
        status: 'warn',
        message: `query failed: ${(err as Error)?.message}`,
      })
    }

    // 4. Provider price resolution (best-effort; gated on price_lookup).
    const driver = await getActiveBillingDriver()
    if (driver.supports('price_lookup') && typeof driver.resolvePriceProduct === 'function') {
      for (const key of Object.keys(cfg.products)) {
        try {
          const price = await driver.resolvePriceProduct(key)
          results.push({
            name: 'price_resolution',
            status: 'ok',
            message: price
              ? `${key} resolves (product ${price.productId ?? 'n/a'})`
              : `${key} resolved with no product`,
          })
        } catch {
          results.push({
            name: 'price_resolution',
            status: 'warn',
            message: `${key} did not resolve as a price — expected if it is a product id; investigate if it should be a price`,
          })
        }
      }
    } else {
      results.push({
        name: 'price_resolution',
        status: 'warn',
        message: `${driver.name} driver has no 'price_lookup' capability — price existence cannot be verified`,
      })
    }

    // 5. Provider API reachable (when the driver exposes a probe).
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

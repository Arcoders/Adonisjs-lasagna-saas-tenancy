import { assertContractCompat } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type { BillingProviderContract } from '../../contracts/billing_provider_contract.js'
import type { BillingDriverName } from '../../contracts/types.js'
import { BILLING_CONTRACT_VERSION } from '../../constants.js'

/**
 * Holds the active billing driver plus any alternates registered by user code.
 * `BillingProvider` seeds the active driver from `config.billing.driver`; tests
 * swap drivers via {@link BillingDriverRegistry.use} for hermetic runs.
 *
 * Stateful (Map-backed): must be resolved via `container.make(...)`, never
 * `new`-ed ad hoc (the architectural test enforces this). Mirrors
 * `IsolationDriverRegistry`.
 */
export default class BillingDriverRegistry {
  readonly #drivers = new Map<string, BillingProviderContract>()
  #activeName: string | undefined

  register(driver: BillingProviderContract, opts: { activate?: boolean } = {}): this {
    // Reject a driver built against an incompatible contract version at
    // registration time (newer than this build throws; older or absent warns).
    assertContractCompat(
      driver.contractVersion,
      BILLING_CONTRACT_VERSION,
      `billing driver "${driver.name}"`
    )
    this.#drivers.set(driver.name, driver)
    if (opts.activate || !this.#activeName) {
      this.#activeName = driver.name
    }
    return this
  }

  /** Switch the active driver to the named one. Throws if not registered. */
  use(name: BillingDriverName | string): this {
    if (!this.#drivers.has(name)) {
      throw new Error(
        `BillingDriverRegistry: driver "${name}" is not registered. ` +
          `Available: ${[...this.#drivers.keys()].join(', ') || '(none)'}`
      )
    }
    this.#activeName = name
    return this
  }

  active(): BillingProviderContract {
    if (!this.#activeName) {
      throw new Error(
        'BillingDriverRegistry: no active driver. ' +
          'Register one in your provider before resolving the active driver.'
      )
    }
    const driver = this.#drivers.get(this.#activeName)
    if (!driver) {
      throw new Error(
        `BillingDriverRegistry: active driver "${this.#activeName}" was unregistered.`
      )
    }
    return driver
  }

  get(name: BillingDriverName | string): BillingProviderContract | undefined {
    return this.#drivers.get(name)
  }

  has(name: BillingDriverName | string): boolean {
    return this.#drivers.has(name)
  }

  list(): readonly string[] {
    return [...this.#drivers.keys()]
  }

  clear(): this {
    this.#drivers.clear()
    this.#activeName = undefined
    return this
  }
}

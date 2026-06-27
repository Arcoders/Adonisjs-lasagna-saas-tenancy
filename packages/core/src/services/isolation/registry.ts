import { assertContractCompat } from '../../sdk/contract_version.js'
import {
  ISOLATION_CONTRACT_VERSION,
  type IsolationDriver,
  type IsolationDriverName,
} from './driver.js'

/**
 * Holds the active `IsolationDriver` plus any alternates registered by user
 * code. The provider seeds the active driver from config; tests can swap
 * drivers via {@link IsolationDriverRegistry.use} for hermetic runs.
 */
export default class IsolationDriverRegistry {
  readonly #drivers = new Map<string, IsolationDriver>()
  #activeName: string | undefined

  /** The isolation-driver contract version this registry enforces. */
  get contractVersion(): number {
    return ISOLATION_CONTRACT_VERSION
  }

  register(driver: IsolationDriver, opts: { activate?: boolean; override?: boolean } = {}): this {
    const name = driver?.name
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('IsolationDriverRegistry.register: driver.name must be a non-empty string.')
    }
    // Fail loudly on a duplicate name rather than silently shadowing an existing
    // driver (a copy-paste name collision would otherwise re-point routing with
    // no signal). Opt in to replacement with { override: true }.
    if (this.#drivers.has(name) && opts.override !== true) {
      throw new Error(
        `IsolationDriverRegistry: a driver named "${name}" is already registered. ` +
          `Pass { override: true } to replace it.`
      )
    }
    // A driver built for a newer core contract would call methods this core does
    // not provide: refuse it. An older one warns; an unversioned one warns.
    assertContractCompat(
      driver.contractVersion,
      ISOLATION_CONTRACT_VERSION,
      `isolation driver "${name}"`
    )
    this.#drivers.set(name, driver)
    if (opts.activate || !this.#activeName) {
      this.#activeName = name
    }
    return this
  }

  /**
   * Switch the active driver to the named one. Throws if not registered.
   */
  use(name: IsolationDriverName | string): this {
    if (!this.#drivers.has(name)) {
      throw new Error(
        `IsolationDriverRegistry: driver "${name}" is not registered. ` +
          `Available: ${[...this.#drivers.keys()].join(', ') || '(none)'}`
      )
    }
    this.#activeName = name
    return this
  }

  active(): IsolationDriver {
    if (!this.#activeName) {
      throw new Error(
        'IsolationDriverRegistry: no active driver. ' +
          'Register one in your provider before resolving the active driver.'
      )
    }
    const driver = this.#drivers.get(this.#activeName)
    if (!driver) {
      throw new Error(
        `IsolationDriverRegistry: active driver "${this.#activeName}" was unregistered.`
      )
    }
    return driver
  }

  get(name: IsolationDriverName | string): IsolationDriver | undefined {
    return this.#drivers.get(name)
  }

  has(name: IsolationDriverName | string): boolean {
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

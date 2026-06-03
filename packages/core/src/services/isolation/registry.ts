import type { IsolationDriver, IsolationDriverName } from './driver.js'

/**
 * Holds the active `IsolationDriver` plus any alternates registered by user
 * code. The provider seeds the active driver from config; tests can swap
 * drivers via {@link IsolationDriverRegistry.use} for hermetic runs.
 */
export default class IsolationDriverRegistry {
  readonly #drivers = new Map<string, IsolationDriver>()
  #activeName: string | undefined

  register(driver: IsolationDriver, opts: { activate?: boolean } = {}): this {
    this.#drivers.set(driver.name, driver)
    if (opts.activate || !this.#activeName) {
      this.#activeName = driver.name
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

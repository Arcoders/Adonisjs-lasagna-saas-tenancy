import ExtensionRegistry from '../extension_registry.js'
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
export default class IsolationDriverRegistry extends ExtensionRegistry<string, IsolationDriver> {
  #activeName: string | undefined

  protected readonly surfaceLabel = 'isolation driver'
  protected override readonly collisionHint = ' Pass { override: true } to replace it.'

  protected override get surfaceContractVersion(): number {
    return ISOLATION_CONTRACT_VERSION
  }

  /**
   * Presence gate for the isolation contract v2 required member `tableLocation`
   * (EXT-2), run UNCONDITIONALLY at registration. `assertContractCompat` only
   * WARNS for a driver declaring an older version (v1 < v2) or no version at all,
   * so the v1->v2 bump ALONE would let a driver missing `tableLocation` register
   * and then crash the first time a satellite asks it where a tenant's data lives.
   * The base runs this independent of the version comparison, so v1, unversioned,
   * and too-old-declared drivers are all caught here. Method presence is necessary
   * but not sufficient: a wrong-shaped `tableLocation` still passes, which the
   * per-driver conformance spec (placement.connectionName === connectionName)
   * backstops.
   */
  protected override assertShape(driver: IsolationDriver): void {
    if (typeof driver.tableLocation !== 'function') {
      throw new Error(
        `IsolationDriverRegistry: driver "${driver.name}" does not implement tableLocation() ` +
          `(required by isolation contract v${ISOLATION_CONTRACT_VERSION}). Implement it to ` +
          `return the placement variant for your storage shape (schema/database/rowscope/` +
          `connection) and set contractVersion: ${ISOLATION_CONTRACT_VERSION}.`
      )
    }
  }

  register(driver: IsolationDriver, opts: { activate?: boolean; override?: boolean } = {}): this {
    const name = this.assertRegistrable(driver, opts)
    this.entries.set(name, driver)
    if (opts.activate || !this.#activeName) {
      this.#activeName = name
    }
    return this
  }

  /**
   * Switch the active driver to the named one. Throws if not registered.
   */
  use(name: IsolationDriverName | string): this {
    if (!this.entries.has(name)) {
      throw new Error(
        `IsolationDriverRegistry: driver "${name}" is not registered. ` +
          `Available: ${[...this.entries.keys()].join(', ') || '(none)'}`
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
    const driver = this.entries.get(this.#activeName)
    if (!driver) {
      throw new Error(
        `IsolationDriverRegistry: active driver "${this.#activeName}" was unregistered.`
      )
    }
    return driver
  }

  get(name: IsolationDriverName | string): IsolationDriver | undefined {
    return this.entries.get(name)
  }

  list(): readonly string[] {
    return [...this.entries.keys()]
  }

  override clear(): this {
    super.clear()
    this.#activeName = undefined
    return this
  }
}

import { assertContractCompat } from '@adonisjs-lasagna/saas-tenancy/sdk'
import { assertSafeMetricName } from './custom_aggregate.js'
import { REPORTING_CONTRACT_VERSION } from './constants.js'
import type { ReportExtension } from './contracts/report_extension.js'

/**
 * Registry of host-defined {@link ReportExtension}s. Bound as a container
 * singleton by `ReportingProvider`; the host registers extensions in its own
 * provider `boot()`:
 *
 * @example
 *   const registry = await app.container.make(ReportExtensionRegistry)
 *   registry.register(new TopPropertiesReport())
 *
 * Names are validated (`assertSafeMetricName`) and unique — a duplicate throws so
 * two extensions can't shadow each other. Each extension's `contractVersion` is
 * checked at registration time via `assertContractCompat`: a version NEWER than
 * the surface fails fast (the extension relies on contract this build doesn't
 * provide); OLDER or absent warns and still registers. Validation lives here, at
 * the point of registration, NOT in the provider `boot()` — hosts register in
 * their own `boot()`, which can run after the satellite's.
 *
 * Pure/dependency-free apart from the name guard + the (pure) version check, so
 * it's unit-testable without a booted app.
 */
export default class ReportExtensionRegistry {
  readonly #extensions = new Map<string, ReportExtension>()
  readonly #contractVersion: number
  readonly #onWarn?: (message: string) => void

  constructor(contractVersion: number = REPORTING_CONTRACT_VERSION, onWarn?: (m: string) => void) {
    this.#contractVersion = contractVersion
    this.#onWarn = onWarn
  }

  /** The extension-contract version this surface implements. */
  get contractVersion(): number {
    return this.#contractVersion
  }

  register(extension: ReportExtension): this {
    assertSafeMetricName(extension.name)
    if (this.#extensions.has(extension.name)) {
      throw new Error(
        `ReportExtensionRegistry: an extension named "${extension.name}" is already registered.`
      )
    }
    assertContractCompat(
      extension.contractVersion,
      this.#contractVersion,
      `report extension "${extension.name}"`,
      this.#onWarn
    )
    this.#extensions.set(extension.name, extension)
    return this
  }

  get(name: string): ReportExtension | undefined {
    return this.#extensions.get(name)
  }

  has(name: string): boolean {
    return this.#extensions.has(name)
  }

  list(): readonly string[] {
    return [...this.#extensions.keys()]
  }

  clear(): this {
    this.#extensions.clear()
    return this
  }
}

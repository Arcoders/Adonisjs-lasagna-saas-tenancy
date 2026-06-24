import { assertSafeMetricName } from './custom_aggregate.js'
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
 * two extensions can't shadow each other. Pure/dependency-free apart from the
 * name guard, so it's unit-testable without a booted app.
 */
export default class ReportExtensionRegistry {
  readonly #extensions = new Map<string, ReportExtension>()

  register(extension: ReportExtension): this {
    assertSafeMetricName(extension.name)
    if (this.#extensions.has(extension.name)) {
      throw new Error(
        `ReportExtensionRegistry: an extension named "${extension.name}" is already registered.`
      )
    }
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

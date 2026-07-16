import ReportExtensionRegistry from '../report_extension_registry.js'
import { REPORTING_CONTRACT_VERSION } from '../constants.js'
import type { ReportExtension, ReportExtensionFilters } from '../contracts/report_extension.js'

export interface CreateTestExtensionOptions {
  name?: string
  description?: string
  /** Defaults to the current `REPORTING_CONTRACT_VERSION` (a compatible report). */
  contractVersion?: number
  /** The value `execute` resolves to: a constant or a function of the filters. */
  result?: unknown | ((filters: ReportExtensionFilters) => unknown)
  /** Make `execute` reject, to exercise error paths. */
  throws?: Error | string
  /** Resolve only after this delay, to exercise the `timeoutMs` guard. */
  delayMs?: number
}

/**
 * Build a {@link ReportExtension} for tests. Pure (no booted app), so it imports
 * cleanly from unit and integration specs alike. Override `contractVersion` to
 * exercise the compatibility check (e.g. `REPORTING_CONTRACT_VERSION + 1` to make
 * `register()` throw), or `delayMs`/`throws` to exercise the execution guards.
 */
export function createTestExtension(options: CreateTestExtensionOptions = {}): ReportExtension {
  const {
    name = 'test_extension',
    description = 'a test report extension',
    contractVersion = REPORTING_CONTRACT_VERSION,
    result = { ok: true },
    throws,
    delayMs,
  } = options

  return {
    name,
    description,
    contractVersion,
    async execute(filters, _options, signal) {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      if (signal?.aborted) throw new Error('aborted')
      if (throws) throw typeof throws === 'string' ? new Error(throws) : throws
      return typeof result === 'function'
        ? (result as (f: ReportExtensionFilters) => unknown)(filters)
        : result
    },
  }
}

/** A fresh {@link ReportExtensionRegistry} pre-loaded with `extensions`. */
export function registryWith(...extensions: ReportExtension[]): ReportExtensionRegistry {
  const registry = new ReportExtensionRegistry()
  for (const extension of extensions) registry.register(extension)
  return registry
}

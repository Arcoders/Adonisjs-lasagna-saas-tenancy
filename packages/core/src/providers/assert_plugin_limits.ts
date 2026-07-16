import type { PluginLimitsConfig } from '../types/config.js'
import PluginBootException from '../exceptions/plugin_boot_exception.js'

/**
 * Registered entry counts for each capped plugin request-path surface, read after
 * every provider's `boot()` has run so the numbers are final.
 */
export interface PluginSurfaceCounts {
  readonly authorizers: number
  readonly middleware: number
  readonly capabilities: number
  readonly schedules: number
}

/**
 * Fail-closed cap enforcement for the plugin request-path surfaces (authorizers,
 * route middleware, capabilities). Runs in the provider's `start()` (after every
 * provider `boot()`, so every plugin registration is final) and aborts the deploy
 * with a {@link PluginBootException} when a surface's registered count exceeds its
 * configured cap. That is the point of the caps: a runaway or hostile plugin that
 * registers thousands of authorizers can't quietly bloat the per-request chain;
 * the operator finds out at boot, not under load.
 *
 * An omitted cap means UNLIMITED (byte-identical to the pre-cap behavior), so a
 * host that never sets `plugins.limits` is unaffected. Pure (no container, no
 * config read) so it unit-tests without an Ignitor, mirroring `assertConfigBounds`.
 * The numeric sanity of each cap (>= 1) is checked separately in `assertConfigBounds`.
 */
export function assertPluginLimits(
  limits: PluginLimitsConfig | undefined,
  counts: PluginSurfaceCounts
): void {
  if (!limits) return

  const check = (
    count: number,
    cap: number | undefined,
    surface: string,
    configPath: string
  ): void => {
    if (cap == null) return
    if (count > cap) {
      throw new PluginBootException(
        `${count} ${surface} are registered but multitenancy.${configPath} caps it at ${cap}. ` +
          `Reduce the registrations or raise the cap.`,
        { phase: 'limits' }
      )
    }
  }

  check(
    counts.authorizers,
    limits.maxAuthorizers,
    'tenant-access authorizers',
    'plugins.limits.maxAuthorizers'
  )
  check(
    counts.middleware,
    limits.maxMiddleware,
    'plugin route middleware',
    'plugins.limits.maxMiddleware'
  )
  check(
    counts.capabilities,
    limits.maxCapabilities,
    'provided capabilities',
    'plugins.limits.maxCapabilities'
  )
  check(counts.schedules, limits.maxSchedules, 'tenant schedules', 'plugins.limits.maxSchedules')
}

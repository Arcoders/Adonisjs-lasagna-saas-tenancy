import app from '@adonisjs/core/services/app'
import type { ExecuteExtensionOptions } from '@adonisjs-lasagna/saas-tenancy/services'
import type { MultitenancyConfigWithReporting } from './validate_config.js'

/**
 * Build `executeExtension` guard options for one report-extension run from the
 * optional `reporting.extensions` config. `discriminator` is the client ip
 * (HTTP) or `undefined` (CLI); it namespaces the rate-limit bucket so one caller
 * can't drain another's budget. When the config block is absent this returns
 * label-only options (no `timeoutMs`, no `rateLimit`), so an unguarded surface
 * behaves exactly as before.
 *
 * Shared by the HTTP controller and the CLI command so both honour the same
 * config and key scheme.
 */
export function resolveExtensionGuards(
  name: string,
  discriminator?: string
): ExecuteExtensionOptions {
  const root = app.config.get('multitenancy') as MultitenancyConfigWithReporting | undefined
  const cfg = root?.reporting?.extensions
  const tail = discriminator ? `:${discriminator}` : ''
  return {
    label: `reporting:${name}`,
    ...(cfg?.timeoutMs !== undefined ? { timeoutMs: cfg.timeoutMs } : {}),
    ...(cfg?.rateLimit !== undefined ? { rateLimit: cfg.rateLimit } : {}),
    rateLimitKey: `ext:reporting:${name}${tail}`,
  }
}

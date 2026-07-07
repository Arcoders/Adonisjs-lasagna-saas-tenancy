/**
 * `@adonisjs-lasagna/saas-tenancy/plugin` — the ONE import a satellite author
 * needs to build a plugin with the {@link definePlugin} facade. It re-exports the
 * facade, the section types, the plugin-surface brands + their smart
 * constructors, the facade contract version, and each seam's public types, so a
 * plugin file is a single `import { definePlugin, authorizerName } from
 * '@adonisjs-lasagna/saas-tenancy/plugin'`.
 *
 * The barrel grows additively per lote alongside `PluginSpec`. It is
 * app.booted-safe: every module reachable from here loads without an Ignitor
 * (registry classes are pulled lazily inside the facade's `boot()`).
 */

export { definePlugin } from './define_plugin.js'
export type { PluginSpec, PluginSection } from './define_plugin.js'

export {
  PLUGIN_API_CONTRACT_VERSION,
  LASAGNA_PLUGIN_API_VERSION,
  assertPluginApiCompatAtBoot,
} from './plugin_api_version.js'

export { assertNever } from './assert_never.js'

/**
 * Branded identifier types + their smart constructors. A branded value is proof
 * it passed `assertSafeIdentifier`; mint every name/key through these so a raw
 * string can never reach a Redis key, a `Symbol`, or DDL.
 */
export { pluginName, authorizerName, middlewareName, macroName, capabilityKey } from './brands.js'
export type {
  PluginName,
  AuthorizerName,
  MiddlewareName,
  MacroName,
  CapabilityKey,
} from './brands.js'

/** SEAM-3 — the tenant-access authorizer chain (fail-closed). */
export { AUTHORIZER_CONTRACT_VERSION } from '../services/authorizer_registry.js'
export type {
  AuthorizerDecision,
  TenantAuthorizer,
  TenantAuthorizerEntry,
} from '../services/authorizer_registry.js'

/** SEAM-2 — route middleware injected into tenant/central/universal groups. */
export { TENANT_MIDDLEWARE_CONTRACT_VERSION } from '../services/tenant_middleware_registry.js'
export type {
  TenantMiddleware,
  TenantMiddlewareHandle,
  TenantMiddlewareScope,
  TenantMiddlewareEntry,
} from '../services/tenant_middleware_registry.js'

/** SEAM-4 — `request.<name>()` macros (umbrella ABI; no per-surface constant). */
export type { TenantRequestMacroSpec } from '../extensions/request.js'

/** Capability registry — optional, degradable cross-plugin composition. Augment
 *  `LasagnaCapabilities` from your plugin to type `consume(key)`. */
export { CAPABILITY_CONTRACT_VERSION } from '../services/capability_registry.js'
export type { CapabilityProvision } from '../services/capability_registry.js'
export type { LasagnaCapabilities } from './capabilities.js'

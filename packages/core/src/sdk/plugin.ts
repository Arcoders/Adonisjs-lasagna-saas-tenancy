/**
 * `@adonisjs-lasagna/saas-tenancy/plugin` is the ONE import a satellite author
 * needs to build a plugin with the {@link definePlugin} facade. It re-exports the
 * facade, the section types, the plugin-surface brands + their smart
 * constructors, the facade contract version, and each seam's public types, so a
 * plugin file is a single `import { definePlugin, authorizerName } from
 * '@adonisjs-lasagna/saas-tenancy/plugin'`.
 *
 * The barrel grows additively per phase alongside `PluginSpec`. It is
 * app.booted-safe: every module reachable from here loads without an Ignitor
 * (registry classes are pulled lazily inside the facade's `boot()`).
 */

export { definePlugin } from './define_plugin.js'
export type { PluginSpec, PluginSection } from './define_plugin.js'

/**
 * The raw provider contract the facade compiles down to. `definePlugin` returns a
 * `SatelliteProviderConstructor`, so both are re-exported here: an author can name
 * the facade's return type, or hand-write the raw route as an escape hatch when a
 * plugin needs more than the declarative surface.
 */
export type { SatelliteProviderContract, SatelliteProviderConstructor } from './contract.js'

/**
 * Typed section builders. The ergonomic way to author a seam entry: pass a
 * plain `name` + callback and the builder mints the branded name, stamps `kind`,
 * and defaults `contractVersion`. `authorizer()` / `middleware()` /
 * `requestMacro()` / `defineCapability()` replace hand-writing the raw
 * discriminated object.
 */
export { authorizer, middleware, requestMacro, defineCapability, schedule } from './builders.js'

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
 *
 * The underlying `Branded<B>` helper stays deliberately un-exported: it is opaque
 * (its brand is a private `unique symbol`), so consumers only ever name the
 * concrete aliases below, never the helper. The api-extractor golden carries one
 * benign `ae-forgotten-export` note for it. Do NOT "fix" it by exporting the
 * `unique symbol`, which would only widen the surface with an unusable primitive.
 */
export {
  pluginName,
  authorizerName,
  middlewareName,
  macroName,
  capabilityKey,
  modelName,
  scheduleName,
} from './brands.js'
export type {
  PluginName,
  AuthorizerName,
  MiddlewareName,
  MacroName,
  CapabilityKey,
  ModelName,
  ScheduleName,
} from './brands.js'

/**
 * Declared plugin permissions (install consent). Populate `definePlugin({
 * permissions })` ONLY through the `permission.*` builders so the declared set
 * stays well-formed and coherent with the manifest wire form the operator
 * consents to. Declaration is disclosure, not enforcement (see the guide).
 */
export { permission } from './plugin_permissions.js'
export type { PluginPermission } from './plugin_permissions.js'

/** The tenant-access authorizer chain (fail-closed). */
export { AUTHORIZER_CONTRACT_VERSION } from '../services/authorizer_registry.js'
export type {
  AuthorizerDecision,
  TenantAuthorizer,
  TenantAuthorizerEntry,
} from '../services/authorizer_registry.js'
/** The tenant a `TenantAuthorizer` receives (plus its status/metadata shapes),
 *  re-exported so an author can type a stand-alone authorize function outside the
 *  inline builder. These are the same public tenant types the root barrel exports. */
export type { TenantModelContract, TenantStatus, TenantMetadata } from '../types/contracts.js'

/** Route middleware injected into tenant/central/universal groups. */
export { TENANT_MIDDLEWARE_CONTRACT_VERSION } from '../services/tenant_middleware_registry.js'
export type {
  TenantMiddleware,
  TenantMiddlewareHandle,
  TenantMiddlewareScope,
  TenantMiddlewareEntry,
} from '../services/tenant_middleware_registry.js'

/** `request.<name>()` macros (umbrella ABI; no per-surface constant). */
export type { TenantRequestMacroSpec } from '../extensions/request.js'

/** Periodic ticks fanned out over active tenants (umbrella ABI). */
export type { TenantSchedule } from '../services/tenant_scheduler_service.js'

/** Postgres extensions provisioned into each tenant's storage (umbrella ABI). */
export type { ProvisionExtensionSpec } from '../services/isolation/vector_provisioning.js'

/** React to committed tenant-model writes (umbrella ABI). The mixin that
 *  EMITS these lives at `@adonisjs-lasagna/saas-tenancy/mixins`. */
export type {
  TenantDataChangeSubscription,
  TenantDataChangePayload,
  TenantDataChangeOperation,
} from '../events/tenant_data_changed.js'

/** Capability registry: optional, degradable cross-plugin composition. Augment
 *  `LasagnaCapabilities` from your plugin to type `consume(key)`. */
export { CAPABILITY_CONTRACT_VERSION } from '../services/capability_registry.js'
export type { CapabilityProvision } from '../services/capability_registry.js'
export type { LasagnaCapabilities } from './capabilities.js'

/**
 * Deep imports into the BUILT core, by exact file path.
 *
 * The micro tier runs with NO Ignitor, so it must never touch the
 * `@adonisjs-lasagna/saas-tenancy/services` (or root) barrel: those re-export
 * `tenant_logger`, which top-level-`await`s `app.booted(...)` and throws when no
 * app exists. Importing the exact files we need sidesteps the whole service
 * graph. The package `exports` field blocks subpath imports of the package
 * name, so these go straight at the emitted files by relative path.
 *
 * Requires `npm run build` (core) first, same as every other tier. Only types
 * may be imported from the public barrel elsewhere (type imports are erased).
 */
export { default as TenantResolverRegistry } from '../../../packages/core/build/src/services/resolvers/registry.js'
export {
  HeaderResolver,
  SubdomainResolver,
  PathResolver,
  DomainOrSubdomainResolver,
  RequestDataResolver,
} from '../../../packages/core/build/src/services/resolvers/builtins.js'

export { default as IsolationDriverRegistry } from '../../../packages/core/build/src/services/isolation/registry.js'
export { default as SchemaPgDriver } from '../../../packages/core/build/src/services/isolation/schema_pg_driver.js'
export {
  default as ConnectionLru,
  DEFAULT_MAX_TENANT_CONNECTIONS,
  DEFAULT_EVICTION_GRACE_MS,
} from '../../../packages/core/build/src/services/isolation/connection_lru.js'

export { default as TenantAdapter } from '../../../packages/core/build/src/models/adapters/tenant_adapter.js'
export { withTenantScope } from '../../../packages/core/build/src/models/scoping.js'

export { __configureTenancyForTests } from '../../../packages/core/build/src/tenancy.js'

// Isthmus guard-audit + tenant-id tokenization: pure-CPU, bare-safe (no app), so
// they price the shield's per-trip machinery without an Ignitor.
export { createGuardAudit } from '../../../packages/core/build/src/sdk/guard_audit.js'
export { tokenizeTenantId } from '../../../packages/core/build/src/sdk/tenant_token.js'

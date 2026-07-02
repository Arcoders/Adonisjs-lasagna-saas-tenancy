/**
 * App.booted-safe building blocks for the official `@adonisjs-lasagna/*`
 * satellite packages (billing, backup, ...). Unlike the `/services` barrel and
 * the root export, importing this module never pulls in
 * `@adonisjs/core/services/logger`, whose top-level `await app.booted()` throws
 * outside an Ignitor. That lets a satellite import these helpers from its own
 * unit runner, which runs without booting a full AdonisJS app.
 *
 * This is NOT part of the stable, app-facing public API. Host applications
 * should import from the documented surfaces (`/services`, `/types`, the root).
 * The contents here may change between minors to follow the satellites' needs.
 *
 * Stability policy: anything a third-party satellite legitimately needs
 * must ALSO live on a stable surface, so no one is forced onto this unstable
 * subpath. The pure tenant-id validators (`isUuidV4`, `assertSafeIdentifier`)
 * are now on the bare-safe `/sdk`, and `buildTestTenant` is on `/testing`. The
 * re-exports below are kept for first-party back-compat. `getActiveDriver`
 * (booted; resolves the active driver — third parties can use the public
 * `IsolationDriverRegistry` on `/services`) and `splitSqlStatementsTagged` (a
 * niche SQL-import helper) remain genuinely internal.
 */
export { assertSafeIdentifier, isUuidV4 } from './services/isolation/identifier.js'
export { getActiveDriver } from './services/isolation/active_driver.js'
export { isProvisionableDriver } from './services/isolation/driver.js'
export { splitSqlStatementsTagged } from './utils/sql_splitter.js'
export { buildTestTenant } from './testing/builders.js'
export type { BuildTestTenantOverrides } from './testing/builders.js'
// Integration-isolation baseline for the resolver chain, consumed by the shared
// test harness (satellite-test-kit) to restore the registry between groups. Pure
// (imports only the registry class), so it does not break /internal boot-safety.
export { createResolverStateBaseline } from './testing/resolver_baseline.js'
export type { ResolverStateBaseline } from './testing/resolver_baseline.js'
// The Isthmus (guard registry + severity-graded audit emit). Internal on
// purpose: the public surface is the IsthmusGuardTripped event on /events and
// the vocabulary types on /types; the registry and emit machinery may evolve
// with the guards. All boot-safe (pure data + lazily-imported dispatch).
export { ISTHMUS_REGISTRY, isthmusEntry } from './isthmus/registry.js'
export type { IsthmusGuardId, IsthmusRegistryEntry } from './isthmus/registry.js'
export {
  ISTHMUS_BUDGETS,
  allowIsthmusEvent,
  emitIsthmusEvent,
  snapshotIsthmusCounters,
} from './isthmus/audit.js'
export type { IsthmusCountersSnapshot, IsthmusEmitOptions } from './isthmus/audit.js'
export { NO_SILENT_GUARD_ALLOWLIST } from './isthmus/no_silent_guard_allowlist.js'

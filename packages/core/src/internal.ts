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

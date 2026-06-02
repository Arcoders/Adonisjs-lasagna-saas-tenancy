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
 */
export { assertSafeIdentifier, isUuidV4 } from './services/isolation/identifier.js'
export { getActiveDriver } from './services/isolation/active_driver.js'
export { splitSqlStatementsTagged } from './utils/sql_splitter.js'
export { buildTestTenant } from './testing/builders.js'
export type { BuildTestTenantOverrides } from './testing/builders.js'

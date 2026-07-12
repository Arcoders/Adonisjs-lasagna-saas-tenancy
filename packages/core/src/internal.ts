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
 * Stability policy (the keep-vs-hide decision): `/internal` REMAINS a
 * published-but-unstable subpath, and the rule that keeps it honest is —
 * anything a third-party satellite legitimately needs must ALSO live on a
 * stable surface, so no one is forced onto this subpath. As of the W4 dedup,
 * every stable-need helper has a stable home and first-party satellites import
 * from it: the tenant-id validators (`isUuidV4`, `assertSafeIdentifier`), the
 * backoffice-table qualifier, and the Isthmus guard-audit (`createGuardAudit` +
 * `ISTHMUS_BUDGETS`) are on the bare-safe `/sdk`; `buildTestTenant` is on
 * `/testing`. What stays here, imported by first-party code only, has no
 * third-party need OR no bare-safe public home: `getActiveDriver` (the public
 * `IsolationDriverRegistry` on `/services` is the third-party route, but the
 * `/services` barrel top-level-awaits `app.booted` via redis, so a satellite
 * module loaded by a BARE unit runner must reach it through this app.booted-safe
 * subpath instead), `isProvisionableDriver` (a driver-capability probe),
 * `splitSqlStatementsTagged` (a niche SQL-import helper), the resolver-baseline
 * seam for the shared test harness, and the Isthmus emit/registry re-exports
 * that core's own integration specs consume.
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
// purpose: the public surface is the IsthmusGuardTripped event on /events, the
// vocabulary types on /types, and (for a satellite that ships its own guards)
// the `createGuardAudit` factory + `ISTHMUS_BUDGETS` on /sdk. The kernel
// registry and its bound emit helpers may evolve with the guards, so they stay
// here for core's own integration specs (which import emitIsthmusEvent /
// snapshotIsthmusCounters from this subpath). `ISTHMUS_BUDGETS` is re-exported
// for back-compat; its single source now lives in sdk/guard_audit.ts. All
// boot-safe (pure data + lazily-imported dispatch).
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
// The envelope primitives and the SSRF guard. Taken off the root barrel in the
// surface freeze: a host app stores a secret through `readSecret` / `writeSecret`
// / `SECRET_CLASS` (still public on the root) and never needs the primitives
// underneath. `decryptWithAppKey` is the app-key rotation seam, and the two URL
// validators guard SSO issuer and webhook URLs. First-party callers only: `ai`
// rotates provider keys, core's own services compose the rest. Both modules
// import nothing but `node:` builtins, so /internal stays app.booted-safe.
export {
  encrypt,
  decrypt,
  decryptStrict,
  decryptWithAppKey,
  isEncrypted,
  sealV2WithKey,
  openV2WithKey,
} from './utils/crypto.js'
export { validateExternalHttpsUrl, validateResolvedHostIsPublic } from './utils/url.js'

// Main entry — SAFE TO IMPORT BEFORE THE APP BOOTS.
//
// A package's `bin/test.integration.ts` imports `runIntegrationSuite` from here
// at the top level, BEFORE the Ignitor creates the AdonisJS application. So this
// barrel must not transitively load any `@adonisjs/core/services/*` or
// `@adonisjs/lucid/services/*` module: those run `await app.booted(...)` /
// container lookups in their module body and throw when `app` is still
// undefined (the original CI failure). The runner pulls in the app-dependent
// bootstrap LAZILY (a dynamic `import('./bootstrap.js')` inside `.configure()`,
// after boot).
//
// Tenant/config helpers live on the `/testing` subpath instead, because they
// import `@adonisjs/lucid/services/db`; specs import them AFTER boot, where that
// is safe. Keeping them off this eager path is what prevents the boot crash.
export { runIntegrationSuite } from './run_integration_suite.js'
export type { RunIntegrationSuiteOptions } from './run_integration_suite.js'

// Guarantee-oriented test foundations (all boot-safe; see module headers).
// The unit runners reach these via a relative source path so the no-build unit
// loop is preserved; integration runners and tooling get them from the build.
export {
  GUARANTEES,
  HARNESS_LEAVES,
  ARCHITECTURE_TIERS,
  INTEGRATION_TIERS,
  TOP_LEVEL_DIRS,
  guaranteeGlobs,
  guaranteeTag,
  isGuarantee,
  resolveSuiteGlobs,
} from './guarantees.js'
export type { Guarantee, GuaranteeGlobs, GuaranteeGlobsOptions } from './guarantees.js'
export { assertGuaranteeTree } from './guarantee_tree.js'
export type { TreeAssert } from './guarantee_tree.js'
export { repoRoot, resolveWorkspaceRoot, readPackageManifest } from './repo_root.js'
export { runUnitSuite } from './runner_entries.js'
// Real-PG run policy (boot-safe: pure env read). The shared REQUIRE_REAL_PG
// fail-loud gate every satellite's real-PG helper uses to turn a would-be
// self-skip into a hard failure when CI declares real Postgres mandatory.
export { realPgRequired, failLoudIfRealPgRequired } from './real_pg.js'

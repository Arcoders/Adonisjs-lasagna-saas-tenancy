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

import { assertCoreAccessAllowed } from './plugin_core_access.js'

/**
 * The sanctioned accessor for the shared Lucid database service, guarded so
 * UNTRUSTED plugin code cannot reach the raw query builder through the funnel
 * (`assertCoreAccessAllowed` throws before the handle is resolved).
 *
 * READ HONESTLY (S5): the db service has no single chokepoint — core itself imports
 * `@adonisjs/lucid/services/db` directly in ~30 places, and a plugin can do the
 * same. So this proxy is IN-PROCESS FRICTION only (it stops a plugin that goes
 * through the blessed path, raising the cost of the careless case), NOT a boundary:
 * a direct `import` evades it entirely. The real, Postgres-enforced containment for
 * untrusted plugin queries is the read-only role (S3), which denies a write on
 * whichever connection the query runs. The repository funnel
 * (`resolveTenantRepository`) is a cleaner internal chokepoint — every one of core's
 * own callers routes through it — but it is friction too, not a boundary: its
 * `TENANT_REPOSITORY` binding is a global `Symbol.for` a plugin can reconstruct and
 * `container.make` directly. See `.github/SECURITY.md`.
 *
 * Lazily imports the db module (which top-level-awaits `app.booted`) so importing
 * this file stays boot-safe.
 */
export async function resolveDatabase() {
  assertCoreAccessAllowed('database')
  const { default: db } = await import('@adonisjs/lucid/services/db')
  return db
}

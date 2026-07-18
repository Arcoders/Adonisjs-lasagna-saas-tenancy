import { getConfig } from '../../../config.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'
import { getActiveDriver } from '../../isolation/active_driver.js'
import { PGVECTOR_EXTENSION, PGVECTOR_EXTENSION_SCHEMA } from '../../isolation/pgvector.js'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

/**
 * True only when the extension exists AND lives in the dedicated
 * `PGVECTOR_EXTENSION_SCHEMA`. A `vector` extension installed elsewhere (e.g. a
 * legacy install in `public`) does NOT resolve from a schema-pg tenant
 * connection whose search_path is `[tenant, extensions]`, so it must be flagged
 * as unresolvable rather than passing on mere existence.
 */
async function extensionInExpectedSchema(conn: any): Promise<boolean> {
  const r = await conn.rawQuery(
    `SELECT 1 FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
     WHERE e.extname = ? AND n.nspname = ?`,
    [PGVECTOR_EXTENSION, PGVECTOR_EXTENSION_SCHEMA]
  )
  return (r.rows ?? r ?? []).length > 0
}

/**
 * Opt-in readiness check for pgvector. Two things it verifies, both backing
 * pgvector's privilege separation:
 *
 *   1. The app's database role is NOT a superuser. `CREATE EXTENSION` should run
 *      under a separate privileged provisioning connection, not the role that
 *      serves tenant requests, so a superuser app role is flagged as a warning.
 *   2. The `vector` extension exists (installed into the dedicated
 *      `PGVECTOR_EXTENSION_SCHEMA`) where embeddings will live: on the shared
 *      database for `schema-pg`/`rowscope-pg`, or in EACH tenant database for
 *      `database-pg`. A missing (or mis-located) extension is an error, since an
 *      embeddings migration declaring a bare `vector(N)` column would then fail
 *      to resolve the type from the tenant connection's search_path.
 *
 * NOT in `builtInChecks` (a host without the AI/vector satellite never needs
 * pgvector, and would always error). Hosts using pgvector register it with
 * `doctorService.register(pgvectorExtensionCheck)`.
 */
const pgvectorExtensionCheck: DoctorCheck = {
  name: 'pgvector_extension',
  description:
    'Verifies the app role is not a superuser and that the pgvector extension is present where embeddings live.',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          message: '@adonisjs/lucid is not available; cannot inspect pgvector provisioning',
        },
      ]
    }

    const cfg = getConfig()
    const central = db.connection(cfg.centralConnectionName)
    const issues: DiagnosisIssue[] = []

    // 1. Least privilege: the app role should not be a superuser.
    const su = await central.rawQuery(`SELECT rolsuper FROM pg_roles WHERE rolname = current_user`)
    const suRows = su.rows ?? su ?? []
    if (suRows[0]?.rolsuper === true) {
      issues.push({
        code: 'app_role_superuser',
        severity: 'warn',
        message:
          'The app database role is a SUPERUSER. pgvector should be installed under a separate ' +
          'privileged provisioning connection (isolation.provisionConnectionName) so the ' +
          'request-serving role stays least-privilege.',
      })
    }

    // 2. Extension presence, dispatched by the active driver's storage shape.
    const driver = await getActiveDriver()
    if (driver.name === 'sqlite-memory') {
      return issues // pgvector is not applicable
    }

    if (driver.name === 'database-pg') {
      const connect = (driver as unknown as { connect?: (t: unknown, o?: unknown) => Promise<any> })
        .connect
      if (typeof connect !== 'function') {
        issues.push({
          code: 'driver_contract',
          severity: 'error',
          message:
            'the active "database-pg" driver does not expose connect(); cannot probe tenant databases',
        })
        return issues
      }
      for (const tenant of ctx.tenants) {
        // Only active tenants have a live database to probe; a suspended/failed/
        // deleted tenant's database may legitimately be gone. A probe failure is
        // recorded per tenant and never aborts the check for the others.
        if (tenant.isDeleted || tenant.status !== 'active') continue
        try {
          const conn = await connect.call(driver, tenant, { bypassSoftCap: true })
          if (!(await extensionInExpectedSchema(conn))) {
            issues.push({
              code: 'vector_extension_missing',
              severity: 'error',
              message: `pgvector extension is missing (or not in the "${PGVECTOR_EXTENSION_SCHEMA}" schema) in tenant "${tenant.name}"'s database; run tenant:vector:provision`,
              tenantId: tenant.id,
            })
          }
        } catch (error) {
          issues.push({
            code: 'vector_check_unreachable',
            severity: 'warn',
            message: `could not probe tenant "${tenant.name}"'s database for pgvector: ${(error as Error).message}`,
            tenantId: tenant.id,
          })
        }
      }
      return issues
    }

    if (driver.name === 'schema-pg' || driver.name === 'rowscope-pg') {
      if (!(await extensionInExpectedSchema(central))) {
        issues.push({
          code: 'vector_extension_missing',
          severity: 'error',
          message: `pgvector extension is missing (or not in the "${PGVECTOR_EXTENSION_SCHEMA}" schema) on the "${cfg.centralConnectionName}" connection; run tenant:vector:provision`,
        })
      }
      return issues
    }

    // Unknown/custom driver: storage shape unknown, so we cannot pick where to probe.
    issues.push({
      code: 'unknown_driver',
      severity: 'warn',
      message: `pgvector check does not know how to probe isolation driver "${driver.name}"; verify the extension manually`,
    })
    return issues
  },
}

export default pgvectorExtensionCheck

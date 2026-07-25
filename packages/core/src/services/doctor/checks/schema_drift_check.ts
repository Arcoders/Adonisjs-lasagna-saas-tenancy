import { getConfig } from '../../../config.js'
import { applyHeal } from '../apply_fix.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)

/**
 * A doctor check that reconciles the tenant registry against the actual PostgreSQL schemas.
 * It queries information_schema.schemata for every schema matching the configured tenant prefix,
 * then reports a tenant-scoped error for each provisioned tenant whose schema is missing
 * (fixable → heal re-provisions and migrates) and a platform warning for each physical schema
 * that has no matching tenant in the registry. In-flight `provisioning` tenants are skipped (a
 * schema being created is not "missing" — that race used to 503 the platform), and a soft-deleted
 * tenant's schema is never treated as an orphan (a retained schema past its window is
 * `tenant_lifecycle`'s job). Returns a single `lucid_unavailable` error when Lucid cannot load.
 */
const schemaDriftCheck: DoctorCheck = {
  name: 'schema_drift',
  description:
    'Compares tenants in the registry against PostgreSQL schemas; flags missing schemas (fixable) and orphan ones.',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const db = await lazyDb()
    if (!db) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          scope: 'platform',
          message: '@adonisjs/lucid is not available; cannot inspect schemas',
        },
      ]
    }

    const cfg = getConfig()
    const central = db.connection(cfg.centralConnectionName)
    const prefix = cfg.tenantSchemaPrefix

    const rows = await central.rawQuery(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE ?`,
      [`${prefix}%`]
    )
    const physical = new Set<string>(
      (rows.rows ?? rows ?? []).map((r: any) => r.schema_name as string)
    )

    const issues: DiagnosisIssue[] = []
    const expected = new Set<string>()

    for (const tenant of ctx.tenants) {
      // A soft-deleted tenant's schema may be dropped (normal) or retained within the
      // window (keepSchema) — either way it is NOT an orphan, so record it as expected
      // and never flag it missing. tenant_lifecycle owns the retained-past-window case.
      if (tenant.isDeleted) {
        expected.add(tenant.schemaName)
        continue
      }
      // An in-flight provisioning tenant has not created its schema yet; flagging it
      // "missing" is a race that used to raise a spurious platform 503. Record it as
      // expected so it is not an orphan, and let provisioning_stalled own the genuinely
      // stuck case.
      if (tenant.isProvisioning) {
        expected.add(tenant.schemaName)
        continue
      }
      expected.add(tenant.schemaName)
      if (!physical.has(tenant.schemaName)) {
        const issue: DiagnosisIssue = {
          code: 'schema_missing',
          severity: 'error',
          scope: 'tenant',
          message: `Tenant "${tenant.name}" registry says ${tenant.status} but schema "${tenant.schemaName}" is missing`,
          tenantId: tenant.id,
          fixable: true,
          meta: { schema: tenant.schemaName, status: tenant.status },
        }
        if (ctx.attemptFix) await applyHeal(issue)
        issues.push(issue)
      }
    }

    for (const schema of physical) {
      if (!expected.has(schema)) {
        issues.push({
          code: 'schema_orphan',
          severity: 'warn',
          scope: 'platform',
          message: `Orphan schema "${schema}" has no matching tenant in the registry`,
          meta: { schema },
        })
      }
    }

    return issues
  },
}

export default schemaDriftCheck

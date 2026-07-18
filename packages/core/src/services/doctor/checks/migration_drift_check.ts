import app from '@adonisjs/core/services/app'
import { getConfig } from '../../../config.js'
import { discoverSatellites, satelliteMigrationDirs } from '../../../sdk/configure_kit.js'
import { assertSafeIdentifier } from '../../../isthmus/guarded_identifier.js'
import { applyHeal } from '../apply_fix.js'
import type { TenantModelContract } from '../../../types/contracts.js'
import type { DoctorCheck, DiagnosisIssue } from '../types.js'

const lazyDb = () => import('@adonisjs/lucid/services/db').then((m) => m.default).catch(() => null)
const lazyMigration = () =>
  import('@adonisjs/lucid/migration')
    .then((m) => m.MigrationRunner)
    .catch(() => null)

// Monotonic suffix so the throwaway source-inspection connection never collides.
let seq = 0

/**
 * The canonical set of migration NAMES the source tree currently defines, folding
 * core + every installed satellite's per-tenant dirs exactly as a real migrate
 * does — so a name here matches the `adonis_schema.name` column byte-for-byte.
 *
 * Computed ONCE per run (all tenants share the same source), via Lucid's own
 * `MigrationSource` (reached through a `MigrationRunner` built against a throwaway
 * clone of the tenant template whose `migrations.paths` is `[...base, ...satellite]`).
 * The clone is registered outside any pool accounting and released immediately; no
 * migration is run, no ledger is touched — it only reads the files from disk, so it
 * cannot mutate a tenant.
 */
async function canonicalSourceNames(
  db: any,
  MigrationRunner: any
): Promise<Set<string>> {
  const templateName = getConfig().isolation.templateConnectionName ?? 'tenant'
  const base = db.manager.get(templateName)?.config
  const basePaths: string[] = base?.migrations?.paths ?? ['database/migrations']

  const hostRoot = app.makePath()
  const extra = satelliteMigrationDirs(hostRoot, await discoverSatellites(hostRoot))

  const tempName = `__drift_source_${seq++}`
  db.manager.add(tempName, {
    ...base,
    migrations: { ...(base?.migrations ?? {}), paths: [...basePaths, ...extra] },
  })
  try {
    const runner = new MigrationRunner(db, app, {
      connectionName: tempName,
      direction: 'up',
      dryRun: true,
    })
    const files: Array<{ name: string }> = await runner.migrationSource.getMigrations()
    return new Set(files.map((f) => f.name))
  } finally {
    if (db.manager.has(tempName)) await db.manager.release(tempName)
  }
}

/**
 * Detects tenants whose migrations are BEHIND the current source tree — a state
 * `migration_state` (which only checks whether `adonis_schema` exists at all) is
 * blind to. It arises in the field after every deploy that ships a new migration
 * (the fleet lags until migrated) and after a restore-from-backup (which pins a
 * tenant to the dump's migration version and never re-migrates).
 *
 * Precise + fleet-scalable: the canonical source name set is computed once, then
 * each active/suspended tenant contributes a single read-only
 * `SELECT name FROM "<schema>".adonis_schema`. `pending = source − ledger` behind
 * head → `migration_behind` (warn, tenant, fixable → heal applies the pending
 * migrations). A ledger name with no matching source file → `migration_corrupt`
 * (warn, tenant, surface only — a removed/rolled-back/squashed migration is
 * ambiguous, never auto-fixed). Tenants with no `adonis_schema` (never migrated)
 * or no schema are left to `migration_state`/`schema_drift`; deleted and
 * provisioning tenants are skipped.
 */
const migrationDriftCheck: DoctorCheck = {
  name: 'migration_drift',
  description:
    'Compares each active/suspended tenant’s applied migrations against the source tree; flags tenants behind head (fixable) and corrupt ledger entries.',

  async run(ctx): Promise<DiagnosisIssue[]> {
    const candidates = ctx.tenants.filter(
      (t: TenantModelContract) => (t.isActive || t.isSuspended) && !t.isDeleted
    )
    if (candidates.length === 0) return []

    const db = await lazyDb()
    const MigrationRunner = await lazyMigration()
    if (!db || !MigrationRunner) {
      return [
        {
          code: 'lucid_unavailable',
          severity: 'error',
          scope: 'platform',
          message: '@adonisjs/lucid is not available; cannot inspect migration drift',
        },
      ]
    }

    let source: Set<string>
    try {
      source = await canonicalSourceNames(db, MigrationRunner)
    } catch (error: any) {
      // Fail SAFE: if the source set cannot be computed we surface one info issue
      // rather than mislabel every tenant as behind/corrupt.
      return [
        {
          code: 'migration_drift_unavailable',
          severity: 'info',
          scope: 'platform',
          message: `Could not compute the source migration set: ${error?.message ?? 'unknown'}`,
        },
      ]
    }

    const central = db.connection(getConfig().centralConnectionName)
    const issues: DiagnosisIssue[] = []

    for (const tenant of candidates) {
      const schema = tenant.schemaName
      // The schema name is registry-derived; validate the tenant id (its only
      // dynamic component) the same way the driver does before interpolating it into
      // the qualified table reference. A malformed id is skipped (the driver would
      // reject it too).
      try {
        assertSafeIdentifier(tenant.id, 'tenant id')
      } catch {
        continue
      }

      let ledger: Set<string>
      try {
        const rows = await central.rawQuery(`SELECT name FROM "${schema}".adonis_schema`)
        ledger = new Set<string>((rows.rows ?? rows ?? []).map((r: any) => r.name as string))
      } catch (error: any) {
        // Missing table/schema (never migrated / schema gone) is owned by
        // migration_state / schema_drift — skip here rather than double-report.
        if (error?.code === '42P01' || error?.code === '3F000') continue
        issues.push({
          code: 'migration_drift_inspect_failed',
          severity: 'warn',
          scope: 'tenant',
          message: `Could not read the migration ledger for "${tenant.name}": ${error?.message ?? 'unknown'}`,
          tenantId: tenant.id,
        })
        continue
      }

      const pending = [...source].filter((name) => !ledger.has(name))
      const corrupt = [...ledger].filter((name) => !source.has(name))

      if (pending.length > 0) {
        const issue: DiagnosisIssue = {
          code: 'migration_behind',
          severity: 'warn',
          scope: 'tenant',
          message: `Tenant "${tenant.name}" is behind head by ${pending.length} migration(s)`,
          tenantId: tenant.id,
          fixable: true,
          meta: { pending: pending.length, behindBy: pending.length, pendingNames: pending.slice(0, 10) },
        }
        if (ctx.attemptFix) await applyHeal(issue)
        issues.push(issue)
      }

      if (corrupt.length > 0) {
        issues.push({
          code: 'migration_corrupt',
          severity: 'warn',
          scope: 'tenant',
          message:
            `Tenant "${tenant.name}" has ${corrupt.length} applied migration(s) with no source file ` +
            `(removed, rolled back, or squashed) — review before acting`,
          tenantId: tenant.id,
          meta: { corrupt: corrupt.length, corruptNames: corrupt.slice(0, 10) },
        })
      }
    }

    return issues
  },
}

export default migrationDriftCheck

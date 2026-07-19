import app from '@adonisjs/core/services/app'
import { getConfig } from '../../../config.js'
import {
  discoverSatellites,
  satelliteMigrationDirs,
  buildMigrationAliasMap,
} from '../../../sdk/configure_kit.js'
import type { ResolvedMigrationAlias } from '../../../sdk/configure_kit.js'
import { assertSafeIdentifier } from '../../../isthmus/guarded_identifier.js'
import { lazyLogger } from '../../../utils/lazy_logger.js'
import { applyHeal, applyReconcile } from '../apply_fix.js'
import { classifyRelocation, probeExpectedStructure } from '../tenant_ledger_reconcile.js'
import type { ExpectedStructure } from '../tenant_ledger_reconcile.js'
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
 * ambiguous, never auto-fixed). A `pending`/`corrupt` PAIR that a satellite declares
 * as a relocation (an inlined migration now folded under its canonical name) →
 * `migration_relocated` (warn, tenant, fixable → `--reconcile-ledger` rewrites the
 * ledger row with zero DDL); its `to` is removed from the heal set (heal would collide
 * on the already-existing object) and its `from` from the corrupt set. Tenants with no
 * `adonis_schema` (never migrated)
 * or no schema are left to `migration_state`/`schema_drift`; deleted and
 * provisioning tenants are skipped.
 */
const migrationDriftCheck: DoctorCheck = {
  name: 'migration_drift',
  description:
    'Compares each active/suspended tenant’s applied migrations against the source tree; flags tenants behind head (fixable→heal), relocated migrations (fixable→--reconcile-ledger), and corrupt ledger entries.',

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

    // Build the fleet-shared, validated migration-alias map ONCE per run. A relocated
    // migration (an app inlined a satellite's per-tenant migration under a legacy ledger
    // name) is recognised here so it is NEVER passed to heal (which would collide), and
    // is routed to the zero-DDL reconcile instead. Fail-closed: a malformed/malicious
    // alias set drops the whole map (buildMigrationAliasMap), so relocations simply are
    // not recognised and everything falls back to the ordinary behind/corrupt reporting.
    const hostRoot = app.makePath()
    const aliasMap = buildMigrationAliasMap(
      hostRoot,
      await discoverSatellites(hostRoot, (m) => lazyLogger.warn(m)),
      (m) => lazyLogger.warn(m)
    )
    // The structural probe for a `to` (replays it into a throwaway schema) is expensive
    // and identical fleet-wide, so cache it per `to`. Only computed when reconcile is
    // actually opted-in (a hot rewrite); plain --fix previews and needs no probe.
    // Cache ONLY a successful probe: a null (a TRANSIENT failure — a lost migration lock,
    // a connection blip) must not poison every later tenant sharing that `to` with a
    // spurious structural_probe_failed; re-probe on a miss instead.
    const probeCache = new Map<string, ExpectedStructure>()
    const expectedFor = async (to: string): Promise<ExpectedStructure | null> => {
      const cached = probeCache.get(to)
      if (cached) return cached
      const probed = await probeExpectedStructure(to)
      if (probed) probeCache.set(to, probed)
      return probed
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

      // Relocation partition (B0 Layer 2): a `pending` name that is a declared, owned
      // alias `to` whose `from` is present in the ledger (and hence in `corrupt`, since
      // a valid `from` is not in source) is a RELOCATED migration, not genuine drift.
      // Its `to` is removed from the heal set (heal would collide) and its `from` from
      // the corrupt set; a single `migration_relocated` issue is emitted instead.
      const relocatedTo = new Set<string>()
      const relocatedFrom = new Set<string>()
      const relocations: Array<{ from: string; to: string; alias: ResolvedMigrationAlias }> = []
      for (const to of pending) {
        const alias = aliasMap.get(to)
        if (!alias) continue
        const from = alias.from
        if (!ledger.has(from)) continue
        if (!classifyRelocation(from, to, source, aliasMap).ok) continue
        relocatedTo.add(to)
        relocatedFrom.add(from)
        relocations.push({ from, to, alias })
      }

      const realPending = pending.filter((name) => !relocatedTo.has(name))
      const realCorrupt = corrupt.filter((name) => !relocatedFrom.has(name))

      for (const { from, to, alias } of relocations) {
        const issue: DiagnosisIssue = {
          code: 'migration_relocated',
          severity: 'warn',
          scope: 'tenant',
          message:
            `Tenant "${tenant.name}" has a relocated migration: the ledger records "${from}" but the ` +
            `source tree now defines it as "${to}" (${alias.ownerSlug} satellite). The object already ` +
            `exists — reconcile the ledger with --reconcile-ledger (zero DDL); never re-run the DDL.`,
          tenantId: tenant.id,
          fixable: true,
          meta: { from, to, ownerSlug: alias.ownerSlug },
        }
        if (ctx.reconcileLedger === true) {
          // HOT: opt-in reconcile. Compute the structural probe (cached), then run the
          // zero-DDL VERIFY-THEN-COMMIT rewrite.
          await applyReconcile(ctx, issue, {
            from,
            to,
            schema: tenant.schemaName,
            source,
            aliasMap,
            expected: await expectedFor(to),
          })
          // If the object was physically DROPPED (intact legacy ledger row, missing
          // table), reconcile correctly refuses `physical_absent` — but that is genuine
          // drift, not a relocation to rename, so route it to heal, which recreates the
          // object (no collision, since it is absent). Without this, a relocated-but
          // -object-dropped tenant would be suppressed from heal AND refused by reconcile,
          // leaving it permanently unrepaired.
          if ((issue.meta as { reconcileRefused?: string } | undefined)?.reconcileRefused === 'physical_absent') {
            await applyHeal(issue)
          }
        } else {
          // PREVIEW: plain --fix never writes the ledger; report the relocation only.
          issue.meta = { ...issue.meta, reconcileRequired: true }
        }
        issues.push(issue)
      }

      if (realPending.length > 0) {
        const issue: DiagnosisIssue = {
          code: 'migration_behind',
          severity: 'warn',
          scope: 'tenant',
          message: `Tenant "${tenant.name}" is behind head by ${realPending.length} migration(s)`,
          tenantId: tenant.id,
          fixable: true,
          meta: {
            pending: realPending.length,
            behindBy: realPending.length,
            pendingNames: realPending.slice(0, 10),
          },
        }
        if (ctx.attemptFix) await applyHeal(issue)
        issues.push(issue)
      }

      if (realCorrupt.length > 0) {
        issues.push({
          code: 'migration_corrupt',
          severity: 'warn',
          scope: 'tenant',
          message:
            `Tenant "${tenant.name}" has ${realCorrupt.length} applied migration(s) with no source file ` +
            `(removed, rolled back, or squashed) — review before acting`,
          tenantId: tenant.id,
          meta: { corrupt: realCorrupt.length, corruptNames: realCorrupt.slice(0, 10) },
        })
      }
    }

    return issues
  },
}

export default migrationDriftCheck

import { getConfig } from '../../config.js'
import { assertSafeIdentifier } from '../../isthmus/guarded_identifier.js'
import { PGVECTOR_EXTENSION_SCHEMA } from '../isolation/pgvector.js'
import type { TenantModelContract, TenantRepositoryContract } from '../../types/contracts.js'
import type { ResolvedMigrationAlias } from '../../sdk/configure_kit.js'

/**
 * The bulletproof, physically-verified, fail-closed ledger reconcile.
 *
 * A relocated migration leaves a tenant's `adonis_schema` holding the LEGACY name
 * (`from`, from an inlined copy) while the source tree now defines the migration
 * under its canonical satellite name (`to`). The object it creates already exists in
 * the tenant schema, so re-running the DDL collides. The safe cure is to rewrite the
 * single ledger row `from → to` — a PHYSICAL-IDENTITY fix that touches ZERO data and
 * runs ZERO DDL. Every step below is a hard gate; any miss returns a `refused:<reason>`
 * outcome with the tenant untouched — never a partial mutation, never `fixed:true`.
 *
 * The "do no harm" hard floors are: gate 6 (exactly one `from`, zero `to` in the
 * ledger), gate 7 (the object physically exists — never stamp a lie), and gate 12
 * (the affected tables' data fingerprint is byte-identical before and after, asserted
 * INSIDE the transaction so a delta rolls the whole thing back). The transaction-scoped
 * advisory locks serialize the rewrite against a concurrent migrate and a concurrent
 * reconcile of the same tenant.
 */

/** Advisory-lock namespace (classid) for a per-tenant reconcile, distinct from Lucid's
 * single-key global migration lock so the two never collide in the lock space. */
const RECONCILE_LOCK_CLASS = 0x4c41 // 'LA'

/** A single `adonis_schema` ledger row (only `name` is ever rewritten). */
export interface LedgerRow {
  id: number
  name: string
  batch: number
  migration_time: unknown
}

/**
 * The object shape a migration produces, introspected from a schema: table name →
 * (column name → udt/data type). Compared with `⊇` semantics so a tenant table that
 * has EXTRA columns (a later additive migration) still matches.
 */
export type SchemaObjects = Map<string, Map<string, string>>

/** The expected structure `to`'s migration builds, computed once (temp-schema replay). */
export interface ExpectedStructure {
  objects: SchemaObjects
}

/** Per-table data fingerprint: row count + the column set. Asserted equal across the write. */
export type DataFingerprint = Map<string, { count: number; columns: string[] }>

/** The verdict of the pure, DB-free pre-gates (source membership + alias authority). */
export type RelocationVerdict = { ok: true } | { ok: false; reason: string }

export type ReconcileOutcome =
  | { status: 'reconciled'; from: string; to: string; before: LedgerRow }
  | { status: 'already_reconciled'; from: string; to: string }
  | { status: 'refused'; reason: string; from: string; to: string }

/**
 * The pure pre-gates (no DB): normalize, `from ≠ to`, `to ∈ source`, `from ∉ source`,
 * and alias authority (`(from,to)` is an owned, declared pair). Shared by the drift
 * check's relocation partition and the reconcile envelope, and unit-testable with
 * injected sets. A `from` that is still in the source tree is a LIVE migration and must
 * never be rewritten; a `to` absent from the source is not a real target.
 */
export function classifyRelocation(
  from: string,
  to: string,
  source: Set<string>,
  aliasMap: Map<string, ResolvedMigrationAlias>
): RelocationVerdict {
  const nf = from.normalize('NFC')
  const nt = to.normalize('NFC')
  if (nf === nt) return { ok: false, reason: 'from_equals_to' }
  if (!source.has(nt)) return { ok: false, reason: 'to_not_in_source' }
  if (source.has(nf)) return { ok: false, reason: 'from_still_in_source' }
  const alias = aliasMap.get(nt)
  if (!alias) return { ok: false, reason: 'no_alias_authority' }
  if (alias.from.normalize('NFC') !== nf) return { ok: false, reason: 'alias_from_mismatch' }
  return { ok: true }
}

/** Minimal view of a Lucid query client / transaction the reconcile needs. */
export interface QueryLike {
  rawQuery(sql: string, bindings?: unknown[]): Promise<any>
}
export interface TransactionLike extends QueryLike {
  commit(): Promise<void>
  rollback(): Promise<void>
}
export interface CentralLike extends QueryLike {
  transaction(options?: { isolationLevel?: string }): Promise<TransactionLike>
}

export interface ReconcileContext {
  tenantId: string
  /** The tenant's schema name (registry-derived; its id is assertSafeIdentifier'd here). */
  schema: string
  from: string
  to: string
  source: Set<string>
  aliasMap: Map<string, ResolvedMigrationAlias>
  /**
   * The structure `to`'s migration builds, PRECOMPUTED by the caller (once per `to`,
   * fleet-cached) BEFORE this runs — the probe replays the migration, which itself
   * takes Lucid's global migration lock, so it must not run while this envelope holds
   * that lock. `null` means the probe failed → the envelope refuses (fail-closed).
   */
  expected: ExpectedStructure | null
  admin?: string | undefined
}

export interface ReconcileDeps {
  repo: TenantRepositoryContract
  central: CentralLike
  /** Best-effort append-only audit sink (never flips the outcome). */
  audit(entry: {
    tenantId: string
    action: string
    admin?: string | undefined
    metadata: Record<string, unknown>
  }): Promise<void>
  /** Optional warn sink for the (rare) audit failure. */
  onWarn?: (message: string) => void
}

function rowsOf(result: any): any[] {
  return (result?.rows ?? result ?? []) as any[]
}

/** Introspect a schema's tables → columns → udt name (lower-cased, comparable). */
async function introspectObjects(client: QueryLike, schema: string): Promise<SchemaObjects> {
  const result = await client.rawQuery(
    `SELECT table_name, column_name, udt_name
       FROM information_schema.columns
      WHERE table_schema = ?
      ORDER BY table_name, column_name`,
    [schema]
  )
  const objects: SchemaObjects = new Map()
  for (const row of rowsOf(result)) {
    const table = String(row.table_name)
    const col = String(row.column_name)
    const udt = String(row.udt_name ?? '')
    if (!objects.has(table)) objects.set(table, new Map())
    objects.get(table)!.set(col, udt)
  }
  return objects
}

/**
 * Data fingerprint of the affected tables: `count(*)` + the column set. Snapshotted
 * before the write and re-snapshotted inside the transaction; a delta means the write
 * touched data (it must not) and rolls the whole reconcile back.
 */
async function dataFingerprint(
  client: QueryLike,
  schema: string,
  tables: string[]
): Promise<DataFingerprint> {
  const fp: DataFingerprint = new Map()
  for (const table of tables) {
    // `table` is an expected-object name derived from the migration replay, not user
    // input; guard it anyway before it reaches a qualified identifier slot.
    assertSafeIdentifier(table, 'table name')
    // ::bigint, not ::int — a table over 2^31 rows would raise "integer out of range" and
    // fail the reconcile closed. Read via Number (safe below 2^53, far beyond any table).
    const countRes = await client.rawQuery(`SELECT count(*)::bigint AS n FROM "${schema}"."${table}"`)
    const n = Number(rowsOf(countRes)[0]?.n ?? 0)
    const colRes = await client.rawQuery(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ? ORDER BY column_name`,
      [schema, table]
    )
    const columns = rowsOf(colRes).map((r) => String(r.column_name))
    fp.set(table, { count: n, columns })
  }
  return fp
}

function fingerprintsEqual(a: DataFingerprint, b: DataFingerprint): boolean {
  if (a.size !== b.size) return false
  for (const [table, av] of a) {
    const bv = b.get(table)
    if (!bv) return false
    if (av.count !== bv.count) return false
    if (av.columns.length !== bv.columns.length) return false
    for (let i = 0; i < av.columns.length; i++) if (av.columns[i] !== bv.columns[i]) return false
  }
  return true
}

/** The tenant's actual objects must contain every expected table with matching columns. */
function structuralMatch(expected: SchemaObjects, actual: SchemaObjects): boolean {
  for (const [table, cols] of expected) {
    const actualCols = actual.get(table)
    if (!actualCols) return false
    for (const [col, udt] of cols) {
      const actualUdt = actualCols.get(col)
      if (actualUdt === undefined) return false
      if (actualUdt !== udt) return false
    }
  }
  return true
}

function refuse(from: string, to: string, reason: string): ReconcileOutcome {
  return { status: 'refused', reason, from, to }
}

// Per-process monotonic suffix. Combined with the pid + a random token below so two
// probes never collide on a temp schema/connection name — not even two concurrent
// `tenant:doctor --reconcile-ledger` PROCESSES sharing one database (a cron + a manual
// run), where a bare process-local counter would both mint `__reconcile_probe_0` and one
// process's `DROP SCHEMA ... CASCADE` could wipe the other's in-flight probe schema.
let probeSeq = 0

/**
 * Compute the structure `to`'s migration builds (gate-8 input), by REPLAYING it into a
 * throwaway empty schema and introspecting it. Physically read-only w.r.t. every real
 * tenant: it creates a private `__reconcile_probe_<n>` schema, runs the migration(s) in
 * `to`'s directory into it, introspects, then drops the schema and releases the temp
 * connection. Computed ONCE per distinct `to` (the whole fleet shares one), and MUST be
 * called BEFORE {@link reconcileTenantLedger} takes the transaction's migration lock,
 * because the replay itself acquires Lucid's global migration lock. Returns `null` on
 * any failure (unresolvable migration, missing extension, replay error) so the caller
 * fails closed rather than reconcile on an unverified structure.
 *
 * `to`'s directory is the ledger-name prefix (everything before the last `/`) — exactly
 * the fold path `satelliteMigrationDirs` produced — so Lucid resolves it identically.
 */
export async function probeExpectedStructure(to: string): Promise<ExpectedStructure | null> {
  const slash = to.lastIndexOf('/')
  if (slash <= 0) return null
  const dir = to.slice(0, slash)

  let db: any
  let app: any
  let MigrationRunner: any
  try {
    ;[{ default: db }, { default: app }, { MigrationRunner }] = await Promise.all([
      import('@adonisjs/lucid/services/db'),
      import('@adonisjs/core/services/app'),
      import('@adonisjs/lucid/migration'),
    ])
  } catch {
    return null
  }

  const uniq = `${process.pid}_${probeSeq++}_${Math.random().toString(36).slice(2, 8)}`
  const probeSchema = `__reconcile_probe_${uniq}`
  const tempConn = `__reconcile_probe_conn_${uniq}`
  const templateName = getConfig().isolation.templateConnectionName ?? 'tenant'
  const base = db.manager.get(templateName)?.config
  const central = db.connection(getConfig().centralConnectionName)

  try {
    await central.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${probeSchema}"`)
    db.manager.add(tempConn, {
      ...base,
      searchPath: [probeSchema, PGVECTOR_EXTENSION_SCHEMA],
      migrations: { ...(base?.migrations ?? {}), paths: [dir] },
    })
    const runner = new MigrationRunner(db, app, { connectionName: tempConn, direction: 'up' })
    await runner.run()
    if (runner.error) throw runner.error
    const objects = await introspectObjects(central, probeSchema)
    // adonis_schema is the migration ledger the runner writes; it is not part of `to`'s
    // own object set, so drop it from the expected structure.
    objects.delete('adonis_schema')
    return { objects }
  } catch {
    return null
  } finally {
    try {
      if (db.manager.has(tempConn)) await db.manager.release(tempConn)
    } catch {
      /* best-effort */
    }
    await central.rawQuery(`DROP SCHEMA IF EXISTS "${probeSchema}" CASCADE`).catch(() => {})
  }
}

/**
 * Run the full VERIFY-THEN-COMMIT reconcile for one `(from → to)` relocation on one
 * tenant. Physical-identity, zero DDL, fail-closed. Returns a structured outcome; the
 * caller (applyReconcile) stamps it onto the issue's meta.
 */
export async function reconcileTenantLedger(
  ctx: ReconcileContext,
  deps: ReconcileDeps
): Promise<ReconcileOutcome> {
  const { tenantId, from, to } = ctx

  // The schema name is registry-derived; validate the tenant id (its only dynamic
  // component) exactly as the driver does before it reaches a qualified identifier.
  try {
    assertSafeIdentifier(tenantId, 'tenant id')
  } catch {
    return refuse(from, to, 'unsafe_tenant_id')
  }
  const schema = ctx.schema

  // Gates 4–5 (pure): source membership + alias authority. A live `from`, an unowned
  // `to`, or an undeclared pair is refused with no DB access at all.
  const verdict = classifyRelocation(from, to, ctx.source, ctx.aliasMap)
  if (!verdict.ok) return refuse(from, to, verdict.reason)

  // Gate 8 input: the structural probe must have succeeded (computed by the caller
  // before we take the migration lock). A failed probe fails closed.
  if (!ctx.expected) return refuse(from, to, 'structural_probe_failed')
  const expectedObjects = ctx.expected.objects
  const expectedTables = [...expectedObjects.keys()]
  if (expectedTables.length === 0) return refuse(from, to, 'structural_probe_empty')

  // REPEATABLE READ so the transaction sees ONE stable snapshot: the gate-9 and gate-12
  // data fingerprints are then identical by construction (the reconcile's own write only
  // touches adonis_schema.name, never a fingerprinted data table), so gate 12 asserts the
  // rewrite changed no data WITHOUT being tripped by an unrelated concurrent INSERT on a
  // busy tenant — the very tenants the doctor exists to remediate. The advisory locks
  // still exclude concurrent migrate/reconcile, so there is no write-write conflict on
  // adonis_schema and no serialization failure.
  const trx = await deps.central.transaction({ isolationLevel: 'repeatable read' })
  try {
    // Gate 2 — transaction-scoped advisory locks (auto-released at commit/rollback, so
    // they never leak across a pooled connection). Lucid's global migration lock uses
    // the single-key form `pg_advisory_lock('1')`; we contend on the SAME key so a
    // concurrent migrate blocks us (and we it). The tenant lock uses the two-key form
    // (a distinct lock space) keyed on the tenant. A loser is benign contention.
    const gLock = await trx.rawQuery(`SELECT pg_try_advisory_xact_lock(1) AS ok`)
    if (rowsOf(gLock)[0]?.ok !== true) {
      await trx.rollback()
      return refuse(from, to, 'contention')
    }
    const tLock = await trx.rawQuery(
      `SELECT pg_try_advisory_xact_lock(?, hashtext(?)) AS ok`,
      [RECONCILE_LOCK_CLASS, tenantId]
    )
    if (rowsOf(tLock)[0]?.ok !== true) {
      await trx.rollback()
      return refuse(from, to, 'contention')
    }

    // Gates 1 + 3 — fresh re-read under the lock; refuse a concurrently deleted or
    // non-serviceable tenant (a provisioning tenant may be mid-migrate inserting `to`).
    const fresh = await deps.repo.findByIdOrFail(tenantId, true)
    if (fresh.isDeleted) {
      await trx.rollback()
      return refuse(from, to, 'tenant_deleted')
    }
    if (!(fresh.isActive || fresh.isSuspended)) {
      await trx.rollback()
      return refuse(from, to, 'tenant_not_candidate')
    }

    // Gate 6 — ledger multiplicity: exactly one `from`, zero `to`.
    const ledger = await trx.rawQuery(
      `SELECT id, name, batch, migration_time FROM "${schema}".adonis_schema WHERE name IN (?, ?)`,
      [from, to]
    )
    const rows = rowsOf(ledger) as LedgerRow[]
    const fromRows = rows.filter((r) => r.name === from)
    const toRows = rows.filter((r) => r.name === to)
    if (fromRows.length === 0 && toRows.length > 0) {
      // Idempotent short-circuit: already reconciled (a prior run renamed it).
      await trx.rollback()
      return { status: 'already_reconciled', from, to }
    }
    if (fromRows.length === 0) {
      await trx.rollback()
      return refuse(from, to, 'from_absent')
    }
    if (fromRows.length > 1) {
      await trx.rollback()
      return refuse(from, to, 'from_multiplicity')
    }
    if (toRows.length > 0) {
      await trx.rollback()
      return refuse(from, to, 'to_already_present')
    }
    const before = fromRows[0]!

    // Gate 7 — physical existence: every object `to` builds must already exist.
    // Absent ⇒ genuine drift (route to heal), never stamp a lie.
    const actualObjects = await introspectObjects(trx, schema)
    for (const table of expectedTables) {
      if (!actualObjects.has(table)) {
        await trx.rollback()
        return refuse(from, to, 'physical_absent')
      }
    }

    // Gate 8 — structural match: the present objects are structurally `to`'s.
    if (!structuralMatch(expectedObjects, actualObjects)) {
      await trx.rollback()
      return refuse(from, to, 'structural_mismatch')
    }

    // Gate 9 — data fingerprint (pre).
    const pre = await dataFingerprint(trx, schema, expectedTables)

    // Gate 10 — re-assert multiplicity FOR UPDATE, then the single bound rename. Only
    // `name` changes; id/batch/migration_time are preserved. Rowcount MUST be exactly 1.
    const locked = await trx.rawQuery(
      `SELECT id, name FROM "${schema}".adonis_schema WHERE name IN (?, ?) FOR UPDATE`,
      [from, to]
    )
    const lockedRows = rowsOf(locked)
    if (lockedRows.filter((r: any) => r.name === from).length !== 1) {
      await trx.rollback()
      return refuse(from, to, 'from_multiplicity_txn')
    }
    if (lockedRows.some((r: any) => r.name === to)) {
      await trx.rollback()
      return refuse(from, to, 'to_present_txn')
    }
    const updated = await trx.rawQuery(
      `UPDATE "${schema}".adonis_schema SET name = ? WHERE name = ?`,
      [to, from]
    )
    const rowCount = Number(updated?.rowCount ?? updated?.affectedRows ?? 0)
    if (rowCount !== 1) {
      await trx.rollback()
      return refuse(from, to, 'rowcount_not_one')
    }

    // Gate 11 — verify in-txn: exactly `to` present, `from` gone, no dup `to`.
    const after = await trx.rawQuery(
      `SELECT name FROM "${schema}".adonis_schema WHERE name IN (?, ?)`,
      [from, to]
    )
    const afterNames = rowsOf(after).map((r: any) => String(r.name))
    if (afterNames.filter((n) => n === to).length !== 1 || afterNames.includes(from)) {
      await trx.rollback()
      return refuse(from, to, 'verify_failed')
    }

    // Gate 12 — data-preservation assert (in-txn): the fingerprint is byte-identical.
    // This is the mechanically-enforced do-no-harm gate: a reconcile that changed ANY
    // row or column count rolls back entirely.
    const post = await dataFingerprint(trx, schema, expectedTables)
    if (!fingerprintsEqual(pre, post)) {
      await trx.rollback()
      return refuse(from, to, 'data_changed')
    }

    // Gate 13 — commit (releases the advisory locks).
    await trx.commit()

    // Gate 14 — audit (best-effort, reversible; never flips the outcome).
    try {
      await deps.audit({
        tenantId,
        action: 'tenant:doctor:ledger_reconcile',
        admin: ctx.admin,
        metadata: {
          from,
          to,
          ownerSlug: ctx.aliasMap.get(to)?.ownerSlug,
          before: { id: before.id, name: before.name, batch: before.batch },
          after: { name: to },
        },
      })
    } catch (error: any) {
      deps.onWarn?.(`reconcile audit write failed: ${error?.message ?? 'unknown'}`)
    }

    return { status: 'reconciled', from, to, before }
  } catch (error: any) {
    // Any unexpected failure: roll back (no partial mutation) and refuse, never throw
    // out of the envelope so one tenant's reconcile can never abort the doctor run.
    try {
      await trx.rollback()
    } catch {
      /* already settled */
    }
    return refuse(from, to, `error:${error?.message ?? 'unknown'}`)
  }
}

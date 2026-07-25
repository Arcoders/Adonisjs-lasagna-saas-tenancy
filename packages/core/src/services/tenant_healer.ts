import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import { lazyLogger } from '../utils/lazy_logger.js'
import { tenancy } from '../tenancy.js'
import { resolveTenantRepository } from './resolve_tenant_repository.js'
import HookRegistry from './hook_registry.js'
import { getActiveDriver } from './isolation/active_driver.js'
import { isProvisionableDriver } from './isolation/driver.js'
import { discoverSatellites, satelliteMigrationDirs } from '../sdk/configure_kit.js'
import { auditCliAction } from '../commands/audit_cli_action.js'
import TenantProvisioned from '../events/tenant_provisioned.js'
import TenantMigrated from '../events/tenant_migrated.js'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * What a heal did. `provisioned` is true only when heal created storage that was
 * absent; `migrated` is the number of migration files applied this run; `already`
 * is true when the tenant was fully healthy going in (no storage created, nothing
 * pending), i.e. an idempotent no-op re-run.
 *
 * `collisions` is the do-no-harm signal: the object names a pending migration tried
 * to create that ALREADY EXIST in the tenant's schema (a duplicate-object collision
 * during migrate). It is non-empty only when heal hit such a collision, which means
 * the migration was relocated/inlined under a different ledger name and the object is
 * already there. The tenant is NOT quarantined in that case (it is not broken); the
 * caller surfaces the collision and routes the operator to `--reconcile-ledger`.
 */
export interface HealTenantResult {
  provisioned: boolean
  migrated: number
  already: boolean
  collisions: string[]
}

export interface HealTenantOptions {
  /**
   * Fire the same lifecycle hooks + events a normal onboarding would: on a fresh
   * provision `before/after:provision` + `TenantProvisioned`, and always
   * `before/after:migrate` + `TenantMigrated`. The `after:migrate` firing is
   * wrapped in `tenancy.run(tenant)` so a seeder's tenant-scoped queries resolve
   * this tenant's schema. Default true — a cured tenant is indistinguishable from
   * a freshly onboarded one.
   */
  fireHooks?: boolean
  /** Acting admin id recorded on the `tenant:heal` audit row (default: system). */
  admin?: string
  /**
   * Write the append-only `tenant:heal` audit row on success. Default true. The
   * onboarding path (`isolation.migrateOnProvision`) sets this false because the
   * tenant creation is already audited by its own create path.
   */
  audit?: boolean
}

/**
 * Probe whether the tenant's per-tenant storage physically exists, driver-agnostically,
 * so heal can tell a fresh provision (fire `after:provision`) from a re-heal of
 * existing-but-unmigrated storage (do not re-fire). Derives the namespace from the
 * driver's own {@link IsolationDriver.tableLocation}, never a hardcoded `tenant_<id>`.
 * For drivers whose storage isn't a separate schema/database (rowscope shares the
 * central tables; sqlite-memory's connection is the namespace) there is nothing to
 * probe, so it reports "exists" and heal relies on `provision` being idempotent.
 */
async function storageExists(
  driver: Awaited<ReturnType<typeof getActiveDriver>>,
  tenant: TenantModelContract
): Promise<boolean> {
  const location = driver.tableLocation(tenant)
  if (location.kind !== 'schema' && location.kind !== 'database') return true

  const { default: db } = await import('@adonisjs/lucid/services/db')
  const central = db.connection(getConfig().centralConnectionName)

  if (location.kind === 'schema') {
    const rows = await central.rawQuery(
      `SELECT 1 FROM information_schema.schemata WHERE schema_name = ?`,
      [location.schema]
    )
    return (rows.rows ?? rows ?? []).length > 0
  }
  const rows = await central.rawQuery(`SELECT 1 FROM pg_database WHERE datname = ?`, [
    location.database,
  ])
  return (rows.rows ?? rows ?? []).length > 0
}

/**
 * The keystone remediation primitive: bring a tenant's storage up to a healthy,
 * fully-migrated, seeded state — the same end state a normal onboarding reaches —
 * WITHOUT ever destroying data. Everything that repairs a tenant (the doctor's
 * `--fix` heals, `tenant:heal`, and `isolation.migrateOnProvision`) composes this
 * one function, so the non-destructive guarantees live in exactly one place.
 *
 * Strictly provision-up-only:
 *   1. Fresh re-read + TOCTOU guard: reload the tenant from the repo and REFUSE if
 *      it is soft-deleted, so a heal racing a concurrent delete can never resurrect
 *      a deleted tenant or write onto a dropped schema.
 *   2. Provision if the storage is absent (idempotent `CREATE SCHEMA IF NOT EXISTS`).
 *      Only a genuinely fresh provision fires `before/after:provision` +
 *      `TenantProvisioned`; re-healing existing storage does not (so the onboarding
 *      path, which provisions first and then heals, never double-fires).
 *   3. Migrate pending only, folding the satellites' per-tenant migration dirs
 *      (`extraMigrationPaths`) — MANDATORY, or a healed tenant would silently lose
 *      its satellite tables (e.g. `ai_embeddings vector(N)`). Locks stay ENABLED so
 *      Lucid's advisory lock serializes a concurrent `InstallTenant` migrate.
 *   4. Fire `before/after:migrate` + `TenantMigrated`, the `after:migrate` firing
 *      wrapped in `tenancy.run(tenant)` so seeders route to this tenant's schema.
 *
 * On failure in steps 2–4 the tenant is quarantined to `failed` (a status write only
 * — no data is touched) and the error is rethrown so the caller records the failure.
 * Two failure classes are treated as benign and NEVER quarantine: (a) migration-lock
 * contention (a concurrent migrate was holding Postgres's global migration advisory
 * lock) is rethrown unchanged, because the lock is exactly what keeps the ledger
 * uncorrupted and the tenant is fine; (b) a duplicate-object collision (a pending
 * migration tried to create an object that already exists — a relocated/inlined
 * migration) returns normally with `collisions` populated and the tenant left in its
 * prior state, so a relocated-but-healthy tenant is never harmed and the caller can
 * route to `--reconcile-ledger`. Heal NEVER calls `destroy`/`reset`/`down`/rollback/`fresh`.
 * Idempotent: a second run provisions nothing and applies zero migrations. The
 * absolute connection ceiling is unbypassable, so heal (even a fleet heal) can never
 * exhaust PostgreSQL.
 */
/**
 * Lucid guards every migration with a single GLOBAL Postgres advisory lock
 * (`PG_TRY_ADVISORY_LOCK('1')` — non-blocking, with a constant key, so ALL tenant
 * migrations against the shared database contend on it, not only the same tenant's).
 * Two overlapping migrations therefore surface `E_UNABLE_ACQUIRE_LOCK` (the loser
 * could not take the lock) or `E_UNABLE_RELEASE_LOCK` (the migration finished but the
 * release bookkeeping raced), or Knex's own `MigrationLocked`. NONE of these means the
 * tenant is broken — the lock is what prevents concurrent migrations from corrupting
 * the ledger — so heal must not quarantine a healthy tenant over the contention.
 */
function isBenignMigrationLockContention(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code
  const name = (error as { name?: string } | null)?.name
  return (
    code === 'E_UNABLE_ACQUIRE_LOCK' ||
    code === 'E_UNABLE_RELEASE_LOCK' ||
    name === 'MigrationLocked'
  )
}

/**
 * The Postgres SQLSTATEs for "the object this DDL creates already exists" — the
 * whole `duplicate_*` family (Class 42). A pending migration that hits one of these
 * is trying to `CREATE` an object the schema already has: not a broken tenant, but a
 * tenant whose migration was relocated or inlined under a different ledger name, so
 * the object is present without a matching ledger row (the relocation state the
 * reconcile flow repairs). Treating these as benign is the UNIVERSAL half of the
 * do-no-harm guarantee: it covers both DECLARED relocations (crypto/ai satellite
 * aliases) and UNDECLARED ones (an app that inlined a satellite migration with no
 * alias, or the orphan-tables-without-ledger "carivo class").
 */
const DUPLICATE_OBJECT_SQLSTATES = new Set([
  '42P07', // duplicate_table
  '42P06', // duplicate_schema
  '42710', // duplicate_object (constraint / index via ADD, sequence, ...)
  '42701', // duplicate_column (an inlined ALTER … ADD COLUMN that already ran)
  '42723', // duplicate_function
])

/**
 * Walk an error's cause chain collecting the first Postgres SQLSTATE it carries.
 * Lucid/Knex may surface the pg error directly (its `.code` is the SQLSTATE) or wrap
 * it, keeping the original under `.originalError` or `.cause`, so we look through a
 * bounded number of links rather than only the top frame.
 */
function pgErrorCode(error: unknown): string | undefined {
  let cur: any = error
  for (let i = 0; i < 8 && cur && typeof cur === 'object'; i++) {
    if (typeof cur.code === 'string' && cur.code.length > 0) return cur.code
    cur = cur.originalError ?? cur.cause
  }
  return undefined
}

/**
 * True when a migrate failure is a benign duplicate-object collision — the object it
 * tried to create already exists (see {@link DUPLICATE_OBJECT_SQLSTATES}). Lucid runs
 * each migration in its own transaction, so the colliding migration rolls back
 * cleanly and any earlier migrations that committed are forward progress: the tenant
 * is never left corrupt, just short one ledger row for an object it already has.
 *
 * Assumption + known limitation: this relies on Lucid wrapping each migration in a
 * transaction. A migration that opts OUT (`static disableTransactions = true`, needed for
 * `CREATE INDEX CONCURRENTLY` etc.) that creates one object and then collides on a later
 * DDL statement leaves the first object un-rolled-back and unrecorded, so a re-heal would
 * re-collide on that orphan and never converge. That combination (a non-transactional
 * per-tenant migration + a partial-apply collision) is unsupported by the benign net;
 * such migrations should be authored idempotently (`IF NOT EXISTS`).
 */
function isBenignDuplicateObjectCollision(error: unknown): boolean {
  const code = pgErrorCode(error)
  return code !== undefined && DUPLICATE_OBJECT_SQLSTATES.has(code)
}

/**
 * Best-effort name of the object(s) a duplicate-object collision reports, for the
 * caller's message and audit metadata. Prefers the pg error's own `.table`, else
 * parses the `… "<name>" already exists` phrasing; falls back to a trimmed message so
 * the collision is never invisible.
 */
function describeCollision(error: unknown): string {
  const table = (error as { table?: string } | null)?.table
  if (typeof table === 'string' && table.length > 0) return table
  const message = (error as { message?: string } | null)?.message ?? String(error)
  const match = message.match(
    /(?:relation|table|schema|type|constraint|index|column|function)\s+"([^"]+)"\s+already exists/i
  )
  if (match?.[1]) return match[1]
  return message.slice(0, 200)
}

export async function healTenant(
  tenant: TenantModelContract,
  opts: HealTenantOptions = {}
): Promise<HealTenantResult> {
  const fireHooks = opts.fireHooks ?? true
  const audit = opts.audit ?? true

  const repo = await resolveTenantRepository()
  // TOCTOU guard: re-read fresh and refuse a concurrently soft-deleted tenant,
  // mirroring tenant:reprovision. A deleted tenant's dropped schema is correct;
  // heal must not recreate it.
  const fresh = await repo.findByIdOrFail(tenant.id, true)
  if (fresh.isDeleted) {
    throw new Error(
      `Refusing to heal tenant "${fresh.name}" (${fresh.id}): it is soft-deleted. ` +
        `Heal recovers failed/unmigrated tenants, not deleted ones.`
    )
  }

  const driver = await getActiveDriver()
  const hooks = await app.container.make(HookRegistry)

  let provisioned = false
  let migrated = 0
  const collisions: string[] = []

  try {
    if (isProvisionableDriver(driver)) {
      const existed = await storageExists(driver, fresh)
      if (!existed && fireHooks) {
        await hooks.run('before', 'provision', { tenant: fresh })
      }
      // Idempotent even when storage exists (CREATE SCHEMA IF NOT EXISTS), so the
      // onboarding path can provision first and then heal without a second create
      // throwing. Only a genuinely fresh provision fires the provision lifecycle.
      await driver.provision(fresh)
      if (!existed) {
        provisioned = true
        if (fireHooks) {
          await hooks.run('after', 'provision', { tenant: fresh })
          await TenantProvisioned.dispatch(fresh)
        }
      }
    }

    const hostRoot = app.makePath()
    const extraMigrationPaths = satelliteMigrationDirs(
      hostRoot,
      await discoverSatellites(hostRoot, (m) => lazyLogger.warn(m))
    )

    if (fireHooks) {
      await hooks.run('before', 'migrate', { tenant: fresh, direction: 'up' })
    }
    // disableLocks stays false: Lucid's global migration advisory lock is what stops
    // a concurrent InstallTenant/heal migrate from interleaving and corrupting the
    // ledger. It is non-blocking, so a loser fails fast with E_UNABLE_ACQUIRE_LOCK
    // rather than queueing — treated as benign contention in the catch below, never
    // as a tenant failure.
    const result = await driver.migrate(fresh, { direction: 'up', extraMigrationPaths })
    migrated = result.executed

    if (fireHooks) {
      // Seeders in after:migrate run tenant-scoped queries; the package sets no ALS
      // scope around hooks, and outside HTTP the adapter fails closed rather than
      // misroute, so heal supplies the scope explicitly.
      await tenancy.run(fresh, async () => {
        await hooks.run('after', 'migrate', { tenant: fresh, direction: 'up' })
      })
      await TenantMigrated.dispatch(fresh, 'up')
    }
  } catch (error) {
    // A concurrent migration holding the global advisory lock is NOT this tenant's
    // failure — the lock is precisely what keeps the ledger uncorrupted — so rethrow
    // it unchanged WITHOUT quarantining. Otherwise a benign race (a fleet heal at
    // concurrency > 1, or a heal overlapping InstallTenant) would flip a perfectly
    // healthy tenant to `failed`.
    if (isBenignMigrationLockContention(error)) {
      throw error
    }
    // Do-no-harm: a duplicate-object collision means a pending migration tried to
    // create an object the schema already has (a relocated/inlined migration recorded
    // under a different ledger name, or an orphan table with no ledger row). The
    // tenant is NOT broken, so it must NOT be quarantined. Surface the collision, leave
    // the tenant in its prior state, and return — the caller routes the operator to
    // `--reconcile-ledger`. Every OTHER migration failure still quarantines below.
    if (isBenignDuplicateObjectCollision(error)) {
      const object = describeCollision(error)
      collisions.push(object)
      lazyLogger.warn(
        `[multitenancy] heal of tenant ${fresh.id}: object "${object}" already exists — ` +
          `a migration was likely relocated or inlined; not quarantining. Run ` +
          `\`tenant:doctor --reconcile-ledger\` to reconcile the ledger.`
      )
    } else {
      // Quarantine: mark failed (status write only, no data touch) so the tenant is
      // flagged for attention and re-healable, then rethrow so the caller records the
      // failure. A non-transactional migration that half-applied cannot be made
      // idempotent here; it is surfaced (quarantine + error), never retried in a loop.
      fresh.status = 'failed'
      await fresh.save()
      throw error
    }
  }

  // Recovery: a tenant that was 'failed' returns to service once its storage is
  // healthy again (the `failed_recoverable` row of TENANT_STATE_MATRIX). Every other
  // status is preserved —
  // a 'suspended' tenant stays suspended (suspension is deliberate), and
  // 'provisioning' is finalized to 'active' by the onboarding caller (WS-7), not here.
  // Skipped on a collision: heal did not complete the migration, so the tenant is
  // left in its prior state ("do no harm"), never promoted off the back of a partial run.
  if (collisions.length === 0 && fresh.status === 'failed') {
    fresh.status = 'active'
    await fresh.save()
  }

  if (audit) {
    await auditCliAction(lazyLogger, {
      tenantId: fresh.id,
      action: 'tenant:heal',
      adminId: opts.admin,
      metadata: { provisioned, migrated, ...(collisions.length > 0 ? { collisions } : {}) },
    })
  }

  return {
    provisioned,
    migrated,
    already: collisions.length === 0 && !provisioned && migrated === 0,
    collisions,
  }
}

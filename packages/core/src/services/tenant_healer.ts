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
 */
export interface HealTenantResult {
  provisioned: boolean
  migrated: number
  already: boolean
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
 * The one exception is benign migration-lock contention (a concurrent migrate was
 * holding Postgres's global migration advisory lock): that is rethrown WITHOUT
 * quarantining, because the lock is exactly what keeps the ledger uncorrupted and the
 * tenant itself is fine. Heal NEVER calls `destroy`/`reset`/`down`/rollback/`fresh`.
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
    // Quarantine: mark failed (status write only, no data touch) so the tenant is
    // flagged for attention and re-healable, then rethrow so the caller records the
    // failure. A non-transactional migration that half-applied cannot be made
    // idempotent here; it is surfaced (quarantine + error), never retried in a loop.
    fresh.status = 'failed'
    await fresh.save()
    throw error
  }

  // Recovery: a tenant that was 'failed' returns to service once its storage is
  // healthy again (row 10 of the state matrix). Every other status is preserved —
  // a 'suspended' tenant stays suspended (suspension is deliberate), and
  // 'provisioning' is finalized to 'active' by the onboarding caller (WS-7), not here.
  if (fresh.status === 'failed') {
    fresh.status = 'active'
    await fresh.save()
  }

  if (audit) {
    await auditCliAction(lazyLogger, {
      tenantId: fresh.id,
      action: 'tenant:heal',
      adminId: opts.admin,
      metadata: { provisioned, migrated },
    })
  }

  return { provisioned, migrated, already: !provisioned && migrated === 0 }
}

import type { MigrateOptions, MigrateResult } from './driver.js'

async function lucid() {
  const [{ default: db }, { default: app }, { MigrationRunner }] = await Promise.all([
    import('@adonisjs/lucid/services/db'),
    import('@adonisjs/core/services/app'),
    import('@adonisjs/lucid/migration'),
  ])
  return { db, app, MigrationRunner }
}

/** Injectable seam so the throwaway-connection logic is unit-testable without Lucid. */
export interface TenantMigrationDeps {
  getLucid?: () => Promise<{ db: any; app: any; MigrationRunner: any }>
}

// Monotonic per-process suffix so two concurrent migrate() calls never share a
// throwaway connection name (which would let one run's release close the other's).
let seq = 0

/**
 * Run a tenant's migrations, folding any `opts.extraMigrationPaths` (the
 * per-tenant satellite-migration directories, SEAM-2) into the source
 * directories the Migrator reads.
 *
 * Lucid's `Migrator` resolves its migration directories from the CONNECTION's
 * `migrations.paths` (via `MigrationSource`), never from its options bag, so an
 * extra path cannot be passed as a runner option. We fold it in by cloning the
 * already-registered tenant connection into a throwaway registration whose
 * `migrations.paths` is `[...connection paths, ...extra]`, running the Migrator
 * against that name, and releasing it in a `finally`. The shared tenant
 * connection is never mutated, so a concurrent routing query on it is unaffected,
 * and the migration ledger + lock live in the same physical database either way.
 *
 * With no extra paths this is a plain run against the tenant connection, so the
 * common path is byte-identical to the previous inline driver code. The caller
 * (the driver) must already have connected the tenant.
 */
export async function runTenantMigrations(
  connectionName: string,
  opts: MigrateOptions,
  deps: TenantMigrationDeps = {}
): Promise<MigrateResult> {
  const { db, app, MigrationRunner } = await (deps.getLucid ?? lucid)()
  const extra = (opts.extraMigrationPaths ?? []).filter(
    (p) => typeof p === 'string' && p.length > 0
  )

  const runAgainst = async (name: string): Promise<MigrateResult> => {
    const runner = new MigrationRunner(db, app, { ...opts, connectionName: name })
    await runner.run()
    if (runner.error) throw runner.error
    return { executed: runner.migratedFiles ? Object.keys(runner.migratedFiles).length : 0 }
  }

  if (extra.length === 0) return runAgainst(connectionName)

  const base = db.manager.get(connectionName)?.config
  const basePaths: string[] = base?.migrations?.paths ?? ['database/migrations']
  const tempName = `__migpaths_${connectionName}_${seq++}`
  const cloned = {
    ...base,
    migrations: { ...(base?.migrations ?? {}), paths: [...basePaths, ...extra] },
  }
  db.manager.add(tempName, cloned)
  try {
    return await runAgainst(tempName)
  } finally {
    if (db.manager.has(tempName)) await db.manager.release(tempName)
  }
}

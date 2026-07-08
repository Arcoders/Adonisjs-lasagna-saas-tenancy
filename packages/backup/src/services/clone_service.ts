import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/sdk'
// `getActiveDriver` + `isProvisionableDriver` stay on the app.booted-safe
// `/internal` surface: sibling backup service modules are loaded by a bare unit
// runner, so they must not pull the `/services` barrel (it top-level-awaits
// `app.booted` via redis). `isProvisionableDriver` is a genuinely-internal
// driver-capability probe with no third-party need (see core/src/internal.ts).
import { getActiveDriver, isProvisionableDriver } from '@adonisjs-lasagna/saas-tenancy/internal'
import type { CloneResult, TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { withTenantOperationLock } from './tenant_operation_lock.js'
import { destructiveLockFailClosed } from '../config.js'

// `CloneResult` is defined in the core (the lifecycle hook context + the
// `TenantCloned` event carry it); re-exported here for this package's consumers.
export type { CloneResult }

/**
 * Options controlling a tenant clone: whether to copy only the schema (the table
 * structure without any rows) and whether to clear the destination tenant's
 * sessions after the copy, so users of the freshly cloned tenant start logged out
 * rather than inheriting the source's live sessions.
 */
export interface CloneOptions {
  schemaOnly: boolean
  clearSessions: boolean
}

const MIGRATION_TABLES = new Set(['adonis_schema', 'adonis_schema_versions'])

/**
 * Clones one tenant into another by provisioning fresh per-tenant storage for the
 * destination and copying the source's schema (and optionally its data) across,
 * table by table, inside a single transaction. It locks the source so a clone
 * cannot race a concurrent restore or backup, and requires a provisionable
 * isolation driver, since a shared-storage driver has no per-tenant storage to
 * provision for the destination.
 */
export default class CloneService {
  async clone(
    source: TenantModelContract,
    destination: TenantModelContract,
    options: CloneOptions
  ): Promise<CloneResult> {
    // Lock on the SOURCE so a clone can't read it while it is being restored or
    // backed up. The destination is freshly provisioned here, so it has no
    // competing operations of its own.
    return withTenantOperationLock(
      source.id,
      'clone',
      () => this.#cloneLocked(source, destination, options),
      { failClosed: destructiveLockFailClosed() }
    )
  }

  async #cloneLocked(
    source: TenantModelContract,
    destination: TenantModelContract,
    options: CloneOptions
  ): Promise<CloneResult> {
    logger.info({ sourceId: source.id, destId: destination.id, options }, 'Starting tenant clone')

    const driver = await getActiveDriver()
    // Clone provisions fresh per-tenant storage for the destination, so it only
    // works on a driver that owns storage. A shared-storage driver (rowscope-pg)
    // has nothing to provision — fail clearly rather than crash on a missing method.
    if (!isProvisionableDriver(driver)) {
      throw new Error(
        `tenant:clone requires a provisionable isolation driver (one that owns per-tenant ` +
          `storage). The active driver "${driver.name}" shares storage across tenants, so there ` +
          `is no destination storage to provision.`
      )
    }

    try {
      await driver.provision(destination)

      // provision() opens the connection but doesn't run migrations.
      await driver.migrate(destination, { direction: 'up' })

      let tablesCopied = 0
      let rowsCopied = 0

      if (!options.schemaOnly) {
        const result = await this.#copyData(source, destination, options)
        tablesCopied = result.tablesCopied
        rowsCopied = result.rowsCopied
      }

      // Pooled connection was opened before migrations + row copy committed;
      // PG caches relation OIDs per session, so reads on it can miss tables
      // that exist on disk. Force the next caller to open a fresh session.
      await driver.disconnect(destination).catch(() => {})

      destination.status = 'active'
      await destination.save()

      logger.info(
        { sourceId: source.id, destId: destination.id, tablesCopied, rowsCopied },
        'Tenant clone completed'
      )

      return { source, destination, tablesCopied, rowsCopied }
    } catch (error: any) {
      destination.status = 'failed'
      await destination.save()

      await driver.destroy(destination).catch((dropErr: Error) => {
        logger.error(
          { destId: destination.id, err: dropErr.message },
          'Failed to drop orphaned destination storage'
        )
      })

      logger.error(
        { sourceId: source.id, destId: destination.id, error: error.message },
        'Clone failed'
      )
      throw error
    }
  }

  async #copyData(
    source: TenantModelContract,
    dest: TenantModelContract,
    options: Pick<CloneOptions, 'clearSessions'>
  ): Promise<{ tablesCopied: number; rowsCopied: number }> {
    const srcSchema = source.schemaName
    const dstSchema = dest.schemaName
    // Re-validate identifiers — driver-derived, but embedded directly in SQL below.
    assertSafeIdentifier(srcSchema, 'source schema')
    assertSafeIdentifier(dstSchema, 'destination schema')

    // Cross-schema ops go on the central pool, not the default — the default
    // is the per-tenant template and resets connection state between
    // statements on some Linux runners.
    const conn = db.connection(getConfig().centralConnectionName)

    const srcTables = await this.#getTableNames(srcSchema, conn)
    const dstTables = await this.#getTableNames(dstSchema, conn)
    const copyable = srcTables.filter((t) => !MIGRATION_TABLES.has(t))
    const dstSet = new Set(dstTables)

    logger.info(
      { srcSchema, dstSchema, srcTables, dstTables, copyable },
      'Clone: discovered tables before copy'
    )

    let rowsCopied = 0
    const perTable: Record<string, number> = {}

    await conn.transaction(async (trx) => {
      await trx.rawQuery(`SET LOCAL session_replication_role = replica`)

      for (const table of copyable) {
        if (!dstSet.has(table)) {
          logger.warn(
            { srcSchema, dstSchema, table },
            'Clone: destination missing table, skipping copy'
          )
          continue
        }
        // pg_tables allows double-quoted names with arbitrary chars; reject those.
        assertSafeIdentifier(table, 'table name')
        // Map columns by NAME, not position. `SELECT *` copies by ordinal, so a
        // source and destination whose columns are in a different order (e.g.
        // they were migrated at different times) would silently write data into
        // the wrong column. Restrict to the shared columns so an added/removed
        // column on either side doesn't break the copy either.
        const srcCols = await this.#getColumnNames(srcSchema, table, trx)
        const dstCols = new Set(await this.#getColumnNames(dstSchema, table, trx))
        const cols = srcCols.filter((c) => dstCols.has(c))
        if (cols.length === 0) {
          logger.warn(
            { srcSchema, dstSchema, table },
            'Clone: no shared columns between source and destination, skipping copy'
          )
          continue
        }
        for (const c of cols) assertSafeIdentifier(c, 'column name')
        const colList = cols.map((c) => `"${c}"`).join(', ')
        const result = await trx.rawQuery(
          `INSERT INTO "${dstSchema}"."${table}" (${colList}) SELECT ${colList} FROM "${srcSchema}"."${table}"`
        )
        const n = (result as any).rowCount ?? 0
        rowsCopied += n
        perTable[table] = n
      }

      await trx.rawQuery(`SET LOCAL session_replication_role = DEFAULT`)

      if (options.clearSessions) {
        await this.#clearAccessTokens(trx, dstSchema)
      }

      await this.#resetIntegerSequences(trx, dstSchema, copyable)
    })

    logger.info(
      { srcSchema, dstSchema, tablesCopied: copyable.length, rowsCopied, perTable },
      'Clone: copy phase finished'
    )

    return { tablesCopied: copyable.length, rowsCopied }
  }

  async #getTableNames(schema: string, conn?: QueryClientContract): Promise<string[]> {
    const runner = conn ?? db
    const result = await runner.rawQuery(
      `SELECT tablename FROM pg_tables WHERE schemaname = ? ORDER BY tablename`,
      [schema]
    )
    return result.rows.map((r: { tablename: string }) => r.tablename)
  }

  async #getColumnNames(
    schema: string,
    table: string,
    runner: QueryClientContract | TransactionClientContract
  ): Promise<string[]> {
    const result = await runner.rawQuery(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = ? AND table_name = ?
        ORDER BY ordinal_position`,
      [schema, table]
    )
    return result.rows.map((r: { column_name: string }) => r.column_name)
  }

  async #resetIntegerSequences(
    trx: TransactionClientContract,
    schema: string,
    tables: string[]
  ): Promise<void> {
    // Identifiers are embedded directly: Knex rawQuery uses `?` placeholders
    // (not `$1`/`$2`), and PG doesn't parameterise identifiers anyway.
    // Each setval runs inside a SAVEPOINT so a missing id column on one
    // table doesn't abort the whole row-copy transaction.
    for (const table of tables) {
      assertSafeIdentifier(table, 'table name')
      await this.#runWithSavepoint(trx, `seq_${table}`, () =>
        trx.rawQuery(
          `DO $$
           DECLARE
             seq text;
           BEGIN
             seq := pg_get_serial_sequence('"${schema}"."${table}"', 'id');
             IF seq IS NOT NULL THEN
               EXECUTE format(
                 'SELECT setval(%L, COALESCE((SELECT MAX(id) FROM "${schema}"."${table}"), 1))',
                 seq
               );
             END IF;
           END $$`
        )
      )
    }
  }

  async #clearAccessTokens(trx: TransactionClientContract, schema: string): Promise<void> {
    await this.#runWithSavepoint(trx, 'clear_tokens', () =>
      trx.rawQuery(`TRUNCATE TABLE "${schema}"."auth_access_tokens"`)
    )
  }

  async #runWithSavepoint(
    trx: TransactionClientContract,
    name: string,
    op: () => Promise<unknown>
  ): Promise<void> {
    const sp = `sp_${name.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 40)}`
    await trx.rawQuery(`SAVEPOINT ${sp}`)
    try {
      await op()
      await trx.rawQuery(`RELEASE SAVEPOINT ${sp}`)
    } catch (err) {
      await trx.rawQuery(`ROLLBACK TO SAVEPOINT ${sp}`)
      logger.warn({ savepoint: sp, err: (err as Error).message }, 'Clone: savepoint rolled back')
    }
  }
}

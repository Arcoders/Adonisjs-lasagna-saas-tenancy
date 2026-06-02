import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { getActiveDriver, assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/internal'
import type { CloneResult, TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

// `CloneResult` is defined in the core (the lifecycle hook context + the
// `TenantCloned` event carry it); re-exported here for this package's consumers.
export type { CloneResult }

export interface CloneOptions {
  schemaOnly: boolean
  clearSessions: boolean
}

const MIGRATION_TABLES = new Set(['adonis_schema', 'adonis_schema_versions'])

export default class CloneService {
  async clone(
    source: TenantModelContract,
    destination: TenantModelContract,
    options: CloneOptions
  ): Promise<CloneResult> {
    logger.info({ sourceId: source.id, destId: destination.id, options }, 'Starting tenant clone')

    const driver = await getActiveDriver()

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
        const result = await trx.rawQuery(
          `INSERT INTO "${dstSchema}"."${table}" SELECT * FROM "${srcSchema}"."${table}"`
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

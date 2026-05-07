import db from '@adonisjs/lucid/services/db'
import logger from '@adonisjs/core/services/logger'
import type { QueryClientContract, TransactionClientContract } from '@adonisjs/lucid/types/database'
import { getConfig } from '../config.js'
import { getActiveDriver } from './isolation/active_driver.js'
import { assertSafeIdentifier } from './isolation/identifier.js'
import type { TenantModelContract } from '../types/contracts.js'

export interface CloneOptions {
  schemaOnly: boolean
  clearSessions: boolean
}

export interface CloneResult {
  source: TenantModelContract
  destination: TenantModelContract
  tablesCopied: number
  rowsCopied: number
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

      // provision() creates the storage and the connection but doesn't run
      // tenant migrations. Run them now so the destination has the same DDL
      // as the source before we copy rows into it.
      await driver.migrate(destination, { direction: 'up' })

      let tablesCopied = 0
      let rowsCopied = 0

      if (!options.schemaOnly) {
        const result = await this.#copyData(source, destination, options)
        tablesCopied = result.tablesCopied
        rowsCopied = result.rowsCopied
      }

      // The destination's pooled connection was opened during provision() —
      // BEFORE migrations created any tables and BEFORE the central
      // connection committed the row copy. PostgreSQL caches relation OIDs
      // and prepared statement plans per session, so leaving that pool
      // around can cause subsequent reads to see an empty (or missing)
      // table even though the data is committed. Disconnecting forces the
      // next driver.connect() call to open a fresh session.
      await driver.disconnect(destination).catch(() => {})

      // Flip the destination to `active` once provisioning, migrations, and
      // (optionally) the row copy have all succeeded. Pre-v2 this was
      // implicit in `tenant.install()`; post-driver-system the package no
      // longer touches the tenant row, so the caller owns the status.
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

      // Best-effort teardown of partial provisioning. `keepData: false` is
      // the default — drops the schema/database created above.
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
    // Schema names are produced by the driver from the tenant id, but
    // we re-validate here so a future driver change can't slip an
    // unsafe identifier into the cross-schema INSERT below.
    assertSafeIdentifier(srcSchema, 'source schema')
    assertSafeIdentifier(dstSchema, 'destination schema')

    // Run cross-schema operations on the central connection rather than the
    // default. The default connection is the per-tenant template that gets
    // cloned by the package at runtime; using it for one-off queries was
    // flaky on Linux runners where the connection state resets between
    // statements. The central connection is a stable, app-owned pool with
    // full database access.
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
        // pg_tables rows aren't user input, but Postgres allows
        // double-quoted table names with arbitrary chars. Reject those
        // — the package's storage model assumes well-behaved
        // identifiers everywhere.
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
    // Each setval is wrapped in a SAVEPOINT — without one, a single failure
    // (table has no integer id column, sequence missing, etc.) would put the
    // whole parent transaction into an aborted state, silently rolling back
    // the row copy on COMMIT.
    for (const table of tables) {
      await this.#runWithSavepoint(trx, `seq_${table}`, () =>
        trx.rawQuery(
          `DO $$
           DECLARE
             seq text;
           BEGIN
             seq := pg_get_serial_sequence(format('%I.%I', $1::text, $2::text), 'id');
             IF seq IS NOT NULL THEN
               EXECUTE format(
                 'SELECT setval(%L, COALESCE((SELECT MAX(id) FROM %I.%I), 1))',
                 seq, $1::text, $2::text
               );
             END IF;
           END $$`,
          [schema, table]
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

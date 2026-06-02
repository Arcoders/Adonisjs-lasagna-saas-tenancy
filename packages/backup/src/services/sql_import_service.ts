import { readFile, access, writeFile, unlink, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  getActiveDriver,
  assertSafeIdentifier,
  splitSqlStatementsTagged,
} from '@adonisjs-lasagna/saas-tenancy/internal'

const isWin = process.platform === 'win32'

// Lazy logger so the module can be imported without a booted AdonisJS app.
// The static `@adonisjs/core/services/logger` import top-level-awaits
// `app.booted()`, which throws outside an Ignitor and blocks unit tests.
const lazyLogger = () =>
  import('@adonisjs/core/services/logger')
    .then((m) => m.default)
    .catch(() => null)

export interface SqlImportOptions {
  sourceSchema: string
  dryRun: boolean
}

export interface SqlImportResult {
  statementsTotal: number
  statementsExecuted: number
  statementsSkipped: number
  copyBlocksExecuted: number
  copyRowsImported: number
  errors: Array<{ statement: string; message: string }>
  /**
   * 'transactional' when the dump was applied via Lucid in a savepoint transaction.
   * 'psql' when the dump contained `COPY … FROM stdin` blocks and was applied by
   * shelling out to the `psql` CLI.
   */
  mode: 'transactional' | 'psql' | 'dry-run'
}

const SKIP_PATTERNS = [
  /^SET\s+search_path/i,
  /^SELECT\s+pg_catalog\.set_config\s*\(\s*'search_path'/i,
  /^\\[a-z]/i,
]

class PsqlNotAvailableError extends Error {
  constructor() {
    super(
      'This dump contains `COPY … FROM stdin` blocks. The importer needs the `psql` ' +
        'command on your PATH to load them. Install the PostgreSQL client tools, or ' +
        're-export the dump with `pg_dump --inserts` so rows are emitted as INSERT statements.'
    )
    this.name = 'PsqlNotAvailableError'
  }
}

interface PgConnectionConfig {
  host: string
  port: number
  user: string
  password?: string
  database: string
}

export default class SqlImportService {
  async import(
    tenant: TenantModelContract,
    filePath: string,
    options: SqlImportOptions
  ): Promise<SqlImportResult> {
    await access(filePath)

    const raw = await readFile(filePath, 'utf-8')
    const transformed = this.#rewriteSchema(raw, options.sourceSchema, tenant.schemaName)
    const tokens = splitSqlStatementsTagged(transformed)
    const hasCopyBlocks = tokens.some((t) => t.kind === 'copy')

    if (options.dryRun) {
      const result: SqlImportResult = {
        statementsTotal: tokens.length,
        statementsExecuted: 0,
        statementsSkipped: 0,
        copyBlocksExecuted: 0,
        copyRowsImported: 0,
        errors: [],
        mode: 'dry-run',
      }
      for (const token of tokens) {
        if (token.kind === 'copy') {
          result.copyBlocksExecuted++
          result.copyRowsImported += token.rows.length
        } else if (this.#shouldSkip(token.text)) {
          result.statementsSkipped++
        } else {
          result.statementsExecuted++
        }
      }
      return result
    }

    if (hasCopyBlocks) {
      return await this.#runViaPsql(tenant, transformed, tokens)
    }

    return await this.#runTransactional(tenant, tokens)
  }

  async #runTransactional(
    tenant: TenantModelContract,
    tokens: ReturnType<typeof splitSqlStatementsTagged>
  ): Promise<SqlImportResult> {
    const result: SqlImportResult = {
      statementsTotal: tokens.length,
      statementsExecuted: 0,
      statementsSkipped: 0,
      copyBlocksExecuted: 0,
      copyRowsImported: 0,
      errors: [],
      mode: 'transactional',
    }

    const driver = await getActiveDriver()
    const connection = await driver.connect(tenant)

    ;(await lazyLogger())?.info(
      { tenantId: tenant.id, schema: tenant.schemaName, total: tokens.length },
      'Starting transactional SQL import'
    )

    await connection.transaction(async (trx: TransactionClientContract) => {
      await trx.rawQuery(`SET LOCAL session_replication_role = replica`)

      let spIndex = 0

      for (const token of tokens) {
        if (token.kind === 'copy') {
          // Should never happen — caller routes COPY-bearing dumps to #runViaPsql
          continue
        }

        const stmt = token.text
        if (this.#shouldSkip(stmt)) {
          result.statementsSkipped++
          continue
        }

        const sp = `_import_sp_${spIndex++}`
        // sp is a counter-derived literal but we validate anyway so
        // the architectural lint can prove the contract holds without
        // having to reason about reachability.
        assertSafeIdentifier(sp, 'savepoint name')
        await trx.rawQuery(`SAVEPOINT ${sp}`)

        try {
          await trx.rawQuery(stmt)
          await trx.rawQuery(`RELEASE SAVEPOINT ${sp}`)
          result.statementsExecuted++
        } catch (err: any) {
          await trx.rawQuery(`ROLLBACK TO SAVEPOINT ${sp}`)
          await trx.rawQuery(`RELEASE SAVEPOINT ${sp}`)
          result.errors.push({
            statement: stmt.slice(0, 200),
            message: err.message ?? String(err),
          })
          ;(await lazyLogger())?.warn({ stmt: stmt.slice(0, 120), err: err.message }, 'Statement failed')
        }
      }

      await trx.rawQuery(`SET LOCAL session_replication_role = DEFAULT`)
    })

    ;(await lazyLogger())?.info(
      {
        tenantId: tenant.id,
        executed: result.statementsExecuted,
        skipped: result.statementsSkipped,
        errors: result.errors.length,
      },
      'Transactional SQL import complete'
    )

    return result
  }

  async #runViaPsql(
    tenant: TenantModelContract,
    transformedSql: string,
    tokens: ReturnType<typeof splitSqlStatementsTagged>
  ): Promise<SqlImportResult> {
    const psqlAvailable = await this.#hasPsql()
    if (!psqlAvailable) {
      throw new PsqlNotAvailableError()
    }

    const cfg = this.#extractPgConfig()

    const dir = await mkdtemp(join(tmpdir(), 'tenant-import-'))
    const tmpFile = join(dir, `${tenant.id}.sql`)
    await writeFile(tmpFile, transformedSql, 'utf-8')

    const result: SqlImportResult = {
      statementsTotal: tokens.length,
      statementsExecuted: 0,
      statementsSkipped: 0,
      copyBlocksExecuted: tokens.filter((t) => t.kind === 'copy').length,
      copyRowsImported: tokens.reduce(
        (n, t) => (t.kind === 'copy' ? n + t.rows.length : n),
        0
      ),
      errors: [],
      mode: 'psql',
    }

    ;(await lazyLogger())?.info(
      {
        tenantId: tenant.id,
        schema: tenant.schemaName,
        copyBlocks: result.copyBlocksExecuted,
        copyRows: result.copyRowsImported,
      },
      'Starting psql SQL import'
    )

    try {
      const stderr = await this.#spawnPsql(cfg, tmpFile)
      const errorLines = stderr
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.startsWith('ERROR:') || l.startsWith('FATAL:'))

      for (const line of errorLines) {
        result.errors.push({ statement: '(see psql stderr)', message: line })
      }

      // Tokens minus skipped meta-commands; everything else handed to psql.
      result.statementsExecuted =
        tokens.filter((t) => t.kind === 'sql' && !this.#shouldSkip(t.text)).length +
        result.copyBlocksExecuted -
        result.errors.length
      result.statementsSkipped = tokens.filter(
        (t) => t.kind === 'sql' && this.#shouldSkip(t.text)
      ).length
    } finally {
      await unlink(tmpFile).catch(() => {})
    }

    ;(await lazyLogger())?.info(
      {
        tenantId: tenant.id,
        executed: result.statementsExecuted,
        copyRows: result.copyRowsImported,
        errors: result.errors.length,
      },
      'psql SQL import complete'
    )

    return result
  }

  /**
   * On Windows, `spawn('psql', …)` does NOT honor PATHEXT, so the binary
   * has to be referenced as `psql.exe`. This avoids passing `shell: true`,
   * which would let `&`, `|`, `;`, etc. inside any arg get interpreted by
   * cmd.exe — a command-injection vector if any spawn arg ever contained
   * untrusted data.
   */
  #psqlBinary(): string {
    return isWin ? 'psql.exe' : 'psql'
  }

  async #hasPsql(): Promise<boolean> {
    return await new Promise((resolve) => {
      const proc = spawn(this.#psqlBinary(), ['--version'])
      proc.on('error', () => resolve(false))
      proc.on('exit', (code) => resolve(code === 0))
    })
  }

  async #spawnPsql(cfg: PgConnectionConfig, file: string): Promise<string> {
    return await new Promise((resolve, reject) => {
      const args = [
        '-h', cfg.host,
        '-p', String(cfg.port),
        '-U', cfg.user,
        '-d', cfg.database,
        '-v', 'ON_ERROR_STOP=off',
        '-f', file,
      ]
      const env = { ...process.env }
      if (cfg.password) env.PGPASSWORD = cfg.password

      const proc = spawn(this.#psqlBinary(), args, { env })
      let stderr = ''
      proc.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      proc.on('error', reject)
      proc.on('exit', (code) => {
        // psql returns 3 when ON_ERROR_STOP=off and some statements errored,
        // 0 when fully successful. Both are acceptable; we report errors via stderr.
        if (code === 0 || code === 3) {
          resolve(stderr)
        } else {
          reject(new Error(`psql exited with code ${code}: ${stderr.slice(0, 500)}`))
        }
      })
    })
  }

  #extractPgConfig(): PgConnectionConfig {
    const pg = getConfig().backup?.pgConnection
    if (!pg?.host || !pg?.user || !pg?.database) {
      throw new Error(
        'multitenancy.backup.pgConnection is not configured. ' +
          'Set host/port/user/password/database in config/multitenancy.ts ' +
          'so the importer can invoke psql for COPY-bearing dumps.'
      )
    }
    return {
      host: pg.host,
      port: Number(pg.port ?? 5432),
      user: pg.user,
      password: pg.password ?? '',
      database: pg.database,
    }
  }

  #rewriteSchema(sql: string, source: string, target: string): string {
    const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const quotedTarget = `"${target}".`

    sql = sql.replace(new RegExp(`"${escapedSource}"\\.`, 'g'), quotedTarget)
    sql = sql.replace(new RegExp(`\\b${escapedSource}\\.`, 'g'), quotedTarget)

    return sql
  }

  #shouldSkip(stmt: string): boolean {
    return SKIP_PATTERNS.some((p) => p.test(stmt.trimStart()))
  }
}

export { PsqlNotAvailableError }

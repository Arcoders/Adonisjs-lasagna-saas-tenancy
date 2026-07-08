import { readFile, access, writeFile, unlink, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/sdk'
// `getActiveDriver` + `splitSqlStatementsTagged` stay on the app.booted-safe
// `/internal` surface: this module is loaded by a bare unit runner (no Ignitor),
// so it must NOT import the `/services` barrel, which transitively top-level-awaits
// `app.booted` via redis. `splitSqlStatementsTagged` is also a genuinely-internal
// helper with no third-party need (see core/src/internal.ts).
import { getActiveDriver, splitSqlStatementsTagged } from '@adonisjs-lasagna/saas-tenancy/internal'
import { withTenantOperationLock } from './tenant_operation_lock.js'
import { destructiveLockFailClosed } from '../config.js'
import { assertRegularFile } from './fs_guards.js'

const isWin = process.platform === 'win32'

// Lazy logger so the module can be imported without a booted AdonisJS app.
// The static `@adonisjs/core/services/logger` import top-level-awaits
// `app.booted()`, which throws outside an Ignitor and blocks unit tests.
const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

export interface SqlImportOptions {
  sourceSchema: string
  dryRun: boolean
  /**
   * All-or-nothing import. When `true` (the default), the first failing
   * statement aborts the whole import and rolls back every change
   * (transactional path), or stops psql at the first error (COPY path) — a
   * restore either fully applies or leaves nothing behind. Set `false` to
   * apply each statement in its own savepoint and continue past failures,
   * collecting them in `errors`; that can leave the tenant PARTIALLY
   * imported, which on a restore path is usually worse than a clean failure,
   * so it is the explicit opt-out, not the default.
   */
  strict?: boolean
  /**
   * Override the safety refusal when the schema rewrite would alter a
   * `<sourceSchema>.` occurrence INSIDE a SQL string literal. By default such a
   * dump is REFUSED (the rewrite would silently corrupt the stored value).
   * Set `true` to import anyway, accepting that corruption. Prefer re-exporting
   * with `pg_dump --inserts` or a matching schema name over forcing.
   */
  force?: boolean
}

export interface SqlImportResult {
  statementsTotal: number
  statementsExecuted: number
  statementsSkipped: number
  copyBlocksExecuted: number
  copyRowsImported: number
  errors: Array<{ statement: string; message: string }>
  /**
   * Non-fatal data-integrity flags, surfaced loudly so a silent mutation never
   * hides in a restore. Today: lines where the schema rewrite touched a
   * `<source>.` substring INSIDE a SQL string literal (the rewriter cannot
   * distinguish identifiers from literals without a full parser, so the value
   * was rewritten — likely corrupting it). Re-export with `pg_dump --inserts`
   * or a matching schema name if any appear.
   */
  warnings: string[]
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

// Start of a `COPY … FROM stdin` data block (mirrors the SQL splitter). The
// lines between this and the `\.` terminator are raw tab-separated data and
// must NOT be schema-rewritten.
const COPY_FROM_STDIN_RE = /^\s*COPY\s+.+\sFROM\s+stdin\b/i

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
    // Serialise against any other backup/restore/clone/import of this tenant.
    // A real (mutating) import is destructive, so it fails closed when the lock
    // is unavailable. A dry run mutates nothing, so it stays fail-open (and the
    // short-circuit means dry runs never need a booted config to decide).
    return withTenantOperationLock(
      tenant.id,
      'import',
      () => this.#importLocked(tenant, filePath, options),
      { failClosed: !options.dryRun && destructiveLockFailClosed() }
    )
  }

  async #importLocked(
    tenant: TenantModelContract,
    filePath: string,
    options: SqlImportOptions
  ): Promise<SqlImportResult> {
    await access(filePath)
    // Reject a symlink standing in for the dump before we read it / hand it to
    // psql. lstat does not follow the link.
    await assertRegularFile(filePath)

    const raw = await readFile(filePath, 'utf-8')
    const suspectLiteralLines: string[] = []
    const transformed = rewriteSchemaPreservingCopyData(
      raw,
      options.sourceSchema,
      tenant.schemaName,
      (line) => suspectLiteralLines.push(line)
    )
    const warnings = suspectLiteralLines.map(
      (line) =>
        `schema rewrite touched "${options.sourceSchema}." inside a string literal — ` +
        `the stored value was likely corrupted: ${line.trim().slice(0, 160)}`
    )
    if (warnings.length > 0) {
      ;(await lazyLogger())?.warn(
        { count: warnings.length, sample: warnings.slice(0, 3) },
        'SQL import rewrote schema references inside string literals — re-export with ' +
          '`pg_dump --inserts` or a matching schema name if these values matter'
      )
    }
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
        warnings,
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

    // Safety refusal (non-dry-run only): the textual schema rewrite cannot tell
    // an identifier from a string literal without a full SQL parser, so a
    // `<source>.` substring inside a literal got rewritten and the stored value
    // is likely corrupted. Refuse unless the caller explicitly forces it. The
    // dry run above already reported the same lines as warnings for inspection.
    assertRewriteLiteralSafety({
      suspectLiteralLines,
      sourceSchema: options.sourceSchema,
      force: options.force,
    })

    if (hasCopyBlocks) {
      const result = await this.#runViaPsql(tenant, transformed, tokens, options.strict ?? true)
      result.warnings = warnings
      return result
    }

    const result = await this.#runTransactional(tenant, tokens, options.strict ?? true)
    result.warnings = warnings
    return result
  }

  async #runTransactional(
    tenant: TenantModelContract,
    tokens: ReturnType<typeof splitSqlStatementsTagged>,
    strict: boolean
  ): Promise<SqlImportResult> {
    const result: SqlImportResult = {
      statementsTotal: tokens.length,
      statementsExecuted: 0,
      statementsSkipped: 0,
      copyBlocksExecuted: 0,
      copyRowsImported: 0,
      errors: [],
      warnings: [],
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

        // Strict mode: no per-statement savepoint. The first failure throws out
        // of the transaction callback, so Lucid rolls the whole import back —
        // all-or-nothing.
        if (strict) {
          await trx.rawQuery(stmt)
          result.statementsExecuted++
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
          ;(await lazyLogger())?.warn(
            { stmt: stmt.slice(0, 120), err: err.message },
            'Statement failed'
          )
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
    tokens: ReturnType<typeof splitSqlStatementsTagged>,
    strict: boolean
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
      copyRowsImported: tokens.reduce((n, t) => (t.kind === 'copy' ? n + t.rows.length : n), 0),
      errors: [],
      warnings: [],
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
      const stderr = await this.#spawnPsql(cfg, tmpFile, strict)
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

  async #spawnPsql(cfg: PgConnectionConfig, file: string, strict: boolean): Promise<string> {
    return await new Promise((resolve, reject) => {
      const args = [
        '-h',
        cfg.host,
        '-p',
        String(cfg.port),
        '-U',
        cfg.user,
        '-d',
        cfg.database,
        // Strict aborts the whole script at the first error (and psql exits
        // non-zero). Non-strict keeps going and reports per-statement errors
        // via stderr.
        '-v',
        `ON_ERROR_STOP=${strict ? 'on' : 'off'}`,
        '-f',
        file,
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
        // Strict: only a clean exit (0) is acceptable; any error must fail the
        // import so the operator knows it didn't fully apply.
        // Non-strict: psql returns 3 when some statements errored under
        // ON_ERROR_STOP=off and 0 when fully successful; both are acceptable
        // and errors are surfaced via stderr.
        const ok = strict ? code === 0 : code === 0 || code === 3
        if (ok) {
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

  #shouldSkip(stmt: string): boolean {
    return SKIP_PATTERNS.some((p) => p.test(stmt.trimStart()))
  }
}

/**
 * Refuse a real import when the schema rewrite would alter a `<source>.`
 * occurrence inside a SQL string literal (which silently corrupts that stored
 * value), unless the caller explicitly forces it. Pure and exported so the
 * refusal contract is unit-testable without a DB / Redis. Throws on refusal;
 * returns silently otherwise.
 */
export function assertRewriteLiteralSafety(opts: {
  suspectLiteralLines: string[]
  sourceSchema: string
  force?: boolean
}): void {
  if (opts.suspectLiteralLines.length === 0 || opts.force) return
  throw new Error(
    `SQL import refused: the schema rewrite would alter "${opts.sourceSchema}." inside ` +
      `${opts.suspectLiteralLines.length} string literal(s), corrupting those stored values. ` +
      `Re-export with \`pg_dump --inserts\` or a matching schema name, or pass force=true to ` +
      `import anyway. First offending line: ${opts.suspectLiteralLines[0]?.trim().slice(0, 160)}`
  )
}

/**
 * Rewrite `<source>.` schema references to the tenant schema everywhere EXCEPT
 * inside `COPY … FROM stdin` data blocks. Bulk COPY rows are raw, tab-separated
 * values; a textual rewrite there would corrupt any cell that happens to
 * contain `<source>.` (e.g. a column value like `public.foo`). The COPY header
 * itself (which legitimately names `schema.table`) is still rewritten.
 *
 * Known remaining gap: a `<source>.` substring inside a SQL *string literal*
 * (outside COPY) is still rewritten — distinguishing identifiers from literals
 * needs a full SQL parser. The importer cannot avoid it, but it refuses to be
 * SILENT about it: `onSuspectLiteral` fires for every line where the rewrite
 * touched a single-quoted literal, and the import surfaces those as warnings.
 * Prefer `pg_dump --inserts` or a matching schema name when the data may
 * contain such values.
 *
 * Exported for unit testing.
 */
export function rewriteSchemaPreservingCopyData(
  sql: string,
  source: string,
  target: string,
  onSuspectLiteral?: (line: string) => void
): string {
  const lines = sql.split('\n')
  const out: string[] = []
  let inCopyData = false

  for (const line of lines) {
    if (!inCopyData && COPY_FROM_STDIN_RE.test(line)) {
      out.push(rewriteSchema(line, source, target))
      inCopyData = true
      continue
    }
    if (inCopyData) {
      if (line === '\\.') inCopyData = false
      out.push(line) // data row or terminator — never rewritten
      continue
    }
    if (onSuspectLiteral && lineRewritesInsideLiteral(line, source)) {
      onSuspectLiteral(line)
    }
    out.push(rewriteSchema(line, source, target))
  }

  return out.join('\n')
}

/**
 * Heuristic for the literal-rewrite gap above: does this line contain a
 * `<source>.` match INSIDE a single-quoted SQL string? Tracks `''` escapes;
 * dollar-quoted strings ($$…$$) are not modeled (rare in pg_dump output).
 * Exported for unit testing.
 */
export function lineRewritesInsideLiteral(line: string, source: string): boolean {
  const regions = singleQuotedRegions(line)
  if (regions.length === 0) return false

  const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?:"${escapedSource}"|\\b${escapedSource})\\.`, 'g')
  let match: RegExpExecArray | null
  while ((match = re.exec(line)) !== null) {
    const at = match.index
    if (regions.some(([start, end]) => at > start && at < end)) return true
  }
  return false
}

/** [start, end] index pairs of single-quoted regions, honouring `''` escapes. */
function singleQuotedRegions(line: string): Array<[number, number]> {
  const regions: Array<[number, number]> = []
  let i = 0
  while (i < line.length) {
    if (line[i] !== "'") {
      i++
      continue
    }
    const start = i
    i++
    while (i < line.length) {
      if (line[i] === "'") {
        if (line[i + 1] === "'") {
          i += 2 // escaped quote inside the literal
          continue
        }
        break
      }
      i++
    }
    regions.push([start, Math.min(i, line.length)])
    i++
  }
  return regions
}

/** Rewrite `<source>.` / `"<source>".` identifier prefixes to the target schema. */
export function rewriteSchema(sql: string, source: string, target: string): string {
  const escapedSource = source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const quotedTarget = `"${target}".`
  sql = sql.replace(new RegExp(`"${escapedSource}"\\.`, 'g'), quotedTarget)
  sql = sql.replace(new RegExp(`\\b${escapedSource}\\.`, 'g'), quotedTarget)
  return sql
}

export { PsqlNotAvailableError }

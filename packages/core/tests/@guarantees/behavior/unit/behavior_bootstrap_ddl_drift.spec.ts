import { test } from '@japa/runner'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The shared satellite-test-kit's ensureBackofficeSchema() hand-mirrors the
 * table DDL that the migration stubs under stubs/migrations/ scaffold into host
 * apps. That mirror has drifted before (the maintenance columns landed in the
 * stub first and the integration suite ran against a stale tenants table), so
 * this spec makes the duplication self-checking: every column a stub defines for
 * a table the bootstrap provisions must appear in the bootstrap's DDL for that
 * table. When it fails, update ensureBackofficeSchema() in
 * packages/satellite-test-kit/src/bootstrap.ts, including an idempotent
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for databases created before the
 * change. (The DDL moved out of core's tests/integration/bootstrap.ts into the
 * kit when core and the satellites unified on one Ignitor boot path.)
 */

const STUBS_DIR = fileURLToPath(new URL('../../../../stubs/migrations/', import.meta.url))
const BOOTSTRAP_PATH = fileURLToPath(
  new URL('../../../../../satellite-test-kit/src/bootstrap.ts', import.meta.url)
)

// Schema-builder methods that define a column. Calls like unique()/index()
// take arrays or existing column names and never define one.
const COLUMN_METHODS = [
  'uuid',
  'string',
  'text',
  'boolean',
  'jsonb',
  'json',
  'integer',
  'bigInteger',
  'increments',
  'timestamp',
  'date',
  'datetime',
  'decimal',
  'float',
  'specificType',
  'enum',
]

function parseStub(source: string): { tableName: string | null; columns: string[] } {
  const tableName = source.match(/protected tableName = '([a-z_]+)'/)?.[1] ?? null
  // Only up() defines the target shape; down() drops columns.
  const upBody = source.split(/async up\(\)/)[1]?.split(/async down\(\)/)[0] ?? ''
  const columnCall = new RegExp(`table\\.(?:${COLUMN_METHODS.join('|')})\\('([a-z_]+)'`, 'g')
  const columns = [...upBody.matchAll(columnCall)].map((m) => m[1]!)
  return { tableName, columns }
}

/**
 * The DDL corpus for one table: its CREATE TABLE template literal plus any
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` patch lines targeting it.
 */
function bootstrapDdlFor(bootstrapSource: string, tableName: string): string | null {
  const create = bootstrapSource.match(
    new RegExp(`CREATE TABLE IF NOT EXISTS backoffice\\.${tableName} \\(([\\s\\S]*?)\\)\``)
  )
  if (!create) return null
  const alters = [
    ...bootstrapSource.matchAll(
      new RegExp(`ALTER TABLE backoffice\\.${tableName} ADD COLUMN IF NOT EXISTS [^\`]+`, 'g')
    ),
  ]
  return create[1] + '\n' + alters.map((m) => m[0]).join('\n')
}

test.group('bootstrap DDL stays in sync with the migration stubs', () => {
  test('every stub column for a bootstrap-provisioned table exists in the bootstrap DDL', async ({
    assert,
  }) => {
    const bootstrapSource = await readFile(BOOTSTRAP_PATH, 'utf8')
    const stubFiles = (await readdir(STUBS_DIR)).filter((f) => f.endsWith('.stub'))

    // Path sanity: if either side moves, fail loudly instead of vacuously
    // passing with nothing to compare.
    assert.isAtLeast(stubFiles.length, 5, `no stubs found under ${STUBS_DIR}`)
    assert.include(
      bootstrapSource,
      'CREATE TABLE IF NOT EXISTS backoffice.tenants',
      'the kit bootstrap no longer provisions backoffice.tenants — update this guard'
    )

    let comparedTables = 0
    for (const file of stubFiles) {
      const { tableName, columns } = parseStub(await readFile(join(STUBS_DIR, file), 'utf8'))
      if (!tableName || columns.length === 0) continue

      const ddl = bootstrapDdlFor(bootstrapSource, tableName)
      // Tables the integration suite never touches (e.g. satellite-only
      // tables provisioned by their own package's bootstrap) are out of
      // scope for this mirror.
      if (!ddl) continue

      comparedTables += 1
      for (const column of columns) {
        assert.match(
          ddl,
          new RegExp(`\\b${column}\\b`),
          `stubs/migrations/${file} defines "${column}" on backoffice.${tableName}, ` +
            `but the hand-mirrored DDL in satellite-test-kit/src/bootstrap.ts does not mention it. ` +
            `Add the column there (plus an idempotent ALTER TABLE ... ADD COLUMN IF NOT EXISTS ` +
            `so pre-existing local databases pick it up).`
        )
      }
    }

    assert.isAtLeast(
      comparedTables,
      3,
      'guard compared suspiciously few tables — check the regexes'
    )
    // Reads several stub files and runs the mirror regexes; give it headroom over
    // the 2s japa default so it never flakes under c8 instrumentation / slow I/O.
  }).timeout(15000)
})

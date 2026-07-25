import { test } from '@japa/runner'
import { readFileSync, existsSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * The AI mirror of core's no_unsafe_raw_sql guard. The vector store is
 * the first raw SQL in this package (pgvector has no Lucid column type). Unlike
 * core, the AI package does not validate identifiers: it interpolates only fixed
 * module constants (the table name, a config-validated dimension), never user
 * input, and binds every value as `?`. So the contract here is simpler: any
 * `${...}` interpolation into rawQuery/raw MUST carry a `// safe-sql: <reason>`
 * marker making that intent visible. It fails the moment a future PR adds an
 * interpolated raw SQL site without the marker.
 */

const AI_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const ROOTS = ['src', 'tenant_migrations'].map((d) =>
  fileURLToPath(new URL(`../../../${d}/`, import.meta.url))
)

const TEMPLATE_RAW_SQL = /\.(?:rawQuery|raw)\(\s*`[^`]*\$\{[\s\S]*?`/g
const SAFE_SQL_MARKER = /\/\/\s*safe-sql:/i

function findInterpolatedRawSql(src: string): number[] {
  const hits: number[] = []
  const re = new RegExp(TEMPLATE_RAW_SQL.source, 'g')
  let m
  while ((m = re.exec(src)) !== null) {
    hits.push(src.slice(0, m.index).split('\n').length)
  }
  return hits
}

function lineHasMarker(src: string, lineNumber: number) {
  const lines = src.split('\n')
  return lines
    .slice(Math.max(0, lineNumber - 2), lineNumber + 1)
    .some((l) => SAFE_SQL_MARKER.test(l))
}

test.group('architectural: raw SQL interpolation must carry a safe-sql marker', () => {
  test('every interpolated rawQuery/raw site in src + tenant_migrations is annotated', ({
    assert,
  }) => {
    const violations = []
    for (const root of ROOTS) {
      if (!existsSync(root)) continue
      for (const file of walkTsFiles(root)) {
        const src = readFileSync(file, 'utf8')
        for (const line of findInterpolatedRawSql(src)) {
          if (lineHasMarker(src, line)) continue
          violations.push(`${relative(AI_ROOT, file).replace(/\\/g, '/')}:${line}`)
        }
      }
    }
    assert.deepEqual(
      violations,
      [],
      [
        'Found rawQuery/.raw call(s) interpolating via template strings without a',
        '`// safe-sql: <reason>` marker. Interpolate only fixed constants (never user',
        'input), bind every value as ?, and annotate the line. Violations:',
        ...violations.map((v) => '  - ' + v),
      ].join('\n')
    )
  })

  test('control: the detector flags an interpolated site and ignores a parameterized one', ({
    assert,
  }) => {
    assert.lengthOf(findInterpolatedRawSql('db.rawQuery(`SELECT * FROM ${t}`)'), 1)
    assert.lengthOf(findInterpolatedRawSql('db.rawQuery(`SELECT 1`, [x])'), 0)
    assert.lengthOf(findInterpolatedRawSql("db.rawQuery('DELETE FROM t WHERE id = ?', [id])"), 0)
  })
})

import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

const SRC_ROOT = fileURLToPath(new URL('../../../src/', import.meta.url))

/**
 * S2-4: anti-regression guard against SQL injection by template-string
 * interpolation. The package's *only* defense against an attacker
 * planting unsafe identifiers in DDL is the `SAFE_IDENT` regex inside
 * `assertSafeIdentifier`. Every file that interpolates a value into a
 * raw SQL call must have made that contract visible — either by
 * calling `assertSafeIdentifier` itself, or by accepting an
 * already-validated identifier from a path that does.
 *
 * This spec walks `src/`, finds every rawQuery / .raw call that uses
 * template-string interpolation (the dangerous pattern), and asserts
 * the same file imports `assertSafeIdentifier` or has an explicit
 * `// safe-sql: <reason>` opt-out marker on the offending line.
 *
 * It will fail the moment a future PR adds a new DDL site without
 * the safety contract.
 */

interface Hit {
  file: string
  line: number
  excerpt: string
}

// Matches: .rawQuery(`...${...}...`) or .raw(`...${...}...`).
// Multiline-aware via [\s\S]. Conservative: we accept any template
// literal that contains a ${...} interpolation as "interpolated raw
// SQL" — even if the interpolation is a literal constant.
const TEMPLATE_RAW_SQL = /\.(?:rawQuery|raw)\(\s*`[^`]*\$\{[\s\S]*?`/g

const ALLOWED_OPT_OUT = /\/\/\s*safe-sql:/i

function findHits(file: string, src: string): Hit[] {
  const hits: Hit[] = []
  // Reset lastIndex on a fresh regex per call (the literal above is
  // hoisted; cloning it keeps each scan independent).
  const re = new RegExp(TEMPLATE_RAW_SQL.source, 'g')
  let m: RegExpExecArray | null
  while ((m = re.exec(src)) !== null) {
    const upToMatch = src.slice(0, m.index)
    const line = upToMatch.split('\n').length
    const excerpt = m[0].split('\n')[0]!.slice(0, 120)
    hits.push({ file, line, excerpt })
  }
  return hits
}

function lineHasOptOut(src: string, lineNumber: number): boolean {
  const lines = src.split('\n')
  // Check the offending line, the line above (lead comment), and one
  // below to keep the developer's annotation flexible.
  const window = lines.slice(Math.max(0, lineNumber - 2), lineNumber + 1)
  return window.some((l) => ALLOWED_OPT_OUT.test(l))
}

test.group('Architectural: raw SQL interpolation must be guarded', () => {
  test('every file that interpolates into rawQuery imports assertSafeIdentifier or opts out per line', ({
    assert,
  }) => {
    const violations: string[] = []

    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file)
      // The validator itself is allowed — it owns the contract.
      if (rel.replace(/\\/g, '/') === 'services/isolation/identifier.ts') continue

      const src = readFileSync(file, 'utf8')
      const hits = findHits(file, src)
      if (hits.length === 0) continue

      const importsValidator = /assertSafeIdentifier/.test(src)
      for (const h of hits) {
        if (importsValidator) continue
        if (lineHasOptOut(src, h.line)) continue
        violations.push(
          `${rel.replace(/\\/g, '/')}:${h.line} interpolates into raw SQL without ` +
            `importing assertSafeIdentifier or annotating with "// safe-sql: <reason>". ` +
            `Excerpt: ${h.excerpt}`
        )
      }
    }

    assert.deepEqual(
      violations,
      [],
      [
        'Found rawQuery / .raw call(s) that interpolate values via template strings ',
        'without a visible safety contract. Either:',
        '  1. import + call assertSafeIdentifier on the interpolated value, OR',
        '  2. annotate the offending line with `// safe-sql: <reason>` (use sparingly).',
        '',
        'Violations:',
        ...violations.map((v) => '  - ' + v),
      ].join('\n')
    )
  })

  test('the regex itself catches the patterns we care about (positive controls)', ({ assert }) => {
    const samples = [
      ['db.rawQuery(`CREATE SCHEMA "${name}"`)', true],
      ['await trx.raw(`SELECT * FROM "${tbl}"`)', true],
      ['db.rawQuery(`SELECT 1`)', false], // no interpolation, no risk
      ["db.rawQuery('CREATE TABLE x')", false], // single-quoted, no interpolation
      ['db.rawQuery(`SELECT 1`, [name])', false], // parameterized
      ['db.rawQuery("SELECT 1")', false],
    ] as const

    for (const [snippet, expected] of samples) {
      const re = new RegExp(TEMPLATE_RAW_SQL.source, 'g')
      const found = re.test(snippet)
      assert.equal(found, expected, `regex must ${expected ? 'flag' : 'ignore'} sample: ${snippet}`)
    }
  })
})

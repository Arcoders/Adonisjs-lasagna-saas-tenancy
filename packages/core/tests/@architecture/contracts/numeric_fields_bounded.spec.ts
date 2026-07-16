import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  registeredNumericLeafNames,
  NUMERIC_CONFIG_FIELDS,
} from '../../../src/providers/numeric_config_fields.js'

/**
 * CFG-2: you cannot add a numeric config tunable without a conscious bounds
 * decision. Every `name: number` / `name?: number` leaf in the multitenancy
 * config type must be covered by `NUMERIC_CONFIG_FIELDS` (bounded with
 * `enforce: true`, or `enforce: false` + a written reason). The exact mirror of
 * the `secret_fields_registered` guard for secrets.
 *
 * Matched by LEAF NAME (last path segment): the registry validates enforced
 * fields by full path, but several fields share a leaf (`port`, `db`), so
 * coverage is checked at the leaf level.
 */
const CONFIG_FILES = [
  fileURLToPath(new URL('../../../src/types/config.ts', import.meta.url)),
  fileURLToPath(new URL('../../../src/types/config/isolation.ts', import.meta.url)),
]

// A property declaration whose type is exactly `number`: `name: number` or
// `name?: number`, with an optional trailing `;`/`,`. Not a comment.
const NUMBER_PROP = /^\s*([a-zA-Z_]\w*)\s*\??\s*:\s*number\s*[;,]?\s*$/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

function numericLeafNames(): string[] {
  const names = new Set<string>()
  for (const file of CONFIG_FILES) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (isComment(line)) continue
      const m = NUMBER_PROP.exec(line)
      if (m) names.add(m[1]!)
    }
  }
  return [...names]
}

test.group('contract — every numeric config field is bounded or exempt', () => {
  test('no numeric config leaf is missing from NUMERIC_CONFIG_FIELDS', ({ assert }) => {
    const registered = registeredNumericLeafNames()
    const violations = numericLeafNames().filter((name) => !registered.has(name))

    assert.deepEqual(
      violations,
      [],
      [
        'Found numeric config field(s) with no bounds decision:',
        ...violations.map((v) => `  - ${v}`),
        '',
        'Add each to NUMERIC_CONFIG_FIELDS with a min (and optional max) and',
        'enforce: true, OR enforce: false + a reason explaining why a bound adds',
        'nothing (correctness-neutral tunable, operator-managed infra endpoint).',
      ].join('\n')
    )
  })

  test('the parser actually found the numeric leaves (not vacuously green)', ({ assert }) => {
    const found = numericLeafNames()
    // Sentinels spread across the required, optional, and isolation blocks.
    for (const leaf of ['threshold', 'maxTenantConnections', 'schemaCacheTtl', 'attempts']) {
      assert.include(found, leaf, `parser must see the ${leaf} leaf`)
    }
    assert.isAbove(found.length, 20, 'parser must see the full numeric surface')
  })

  test('every enforced field carries a min; exempt fields carry a reason', ({ assert }) => {
    const problems: string[] = []
    for (const field of NUMERIC_CONFIG_FIELDS) {
      if (field.enforce) {
        if (typeof field.min !== 'number') problems.push(`${field.path}: enforced without a min`)
        if (field.max !== undefined && field.max < (field.min ?? 0)) {
          problems.push(`${field.path}: max < min`)
        }
      } else if (!field.reason?.trim()) {
        problems.push(`${field.path}: exempt without a reason`)
      }
    }
    assert.deepEqual(problems, [], problems.join('\n'))
  })

  test('no enforced numeric path uses [] array grammar the reader cannot navigate', ({
    assert,
  }) => {
    // readConfigPath in assert_config_bounds walks dotted paths only, so an
    // enforced field whose path contains `[]` would silently never be checked.
    const offenders = NUMERIC_CONFIG_FIELDS.filter((f) => f.enforce && f.path.includes('[]')).map(
      (f) => f.path
    )
    assert.deepEqual(offenders, [], `enforced numeric path(s) use []: ${offenders.join(', ')}`)
  })

  test('detector control: a hypothetical unregistered numeric leaf would be flagged', ({
    assert,
  }) => {
    const registered = registeredNumericLeafNames()
    assert.isFalse(
      registered.has('someBrandNewLimit'),
      'a hypothetical new tunable is unregistered'
    )
    assert.match('  someBrandNewLimit?: number', NUMBER_PROP)
    assert.notMatch('  getTier?: (t) => string', NUMBER_PROP)
    assert.notMatch('  limits: Record<string, number>', NUMBER_PROP)
  })
})

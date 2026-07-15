import { test } from '@japa/runner'
// This guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the wrapped-DEK column allowlist: no plaintext-DEK column,
// exactly the reviewed non-plaintext set.
import {
  auditWrappedDekTable,
  ALLOWED_COLUMNS,
  ROWSCOPE_ALLOWED_COLUMNS,
  discoverMigrations,
  missingMigrationMarkers,
} from '../../../../../scripts/check-crypto-invariant-2.mjs'

const PATH = 'packages/crypto/tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts'
const ROWSCOPE_PATH = 'packages/crypto/stubs/migrations/create_crypto_wrapped_deks_rowscope.stub'

/** A raw CREATE TABLE body with the given columns, one `<name> text` per line. */
function migration(columns: string[]): string {
  const lines = columns.map((c) => `        ${c} text NOT NULL,`).join('\n')
  return ['this.schema.raw(`', '      CREATE TABLE ${table} (', lines, '      )`)'].join('\n')
}

/** Like `migration`, plus one extra column line with an arbitrary type declaration. */
function migrationWithExtra(columns: string[], extra: string): string {
  const lines = [...columns.map((c) => `        ${c} text NOT NULL,`), `        ${extra},`].join(
    '\n'
  )
  return ['this.schema.raw(`', '      CREATE TABLE ${table} (', lines, '      )`)'].join('\n')
}

test.group('architectural: wrapped-DEK column allowlist', () => {
  test('the exact reviewed allowlist passes', ({ assert }) => {
    const problems = auditWrappedDekTable([{ path: PATH, source: migration(ALLOWED_COLUMNS) }])
    assert.deepEqual(problems, [])
  })

  test('a plaintext-DEK column is a violation', ({ assert }) => {
    const problems = auditWrappedDekTable([
      { path: PATH, source: migration([...ALLOWED_COLUMNS, 'plaintext_dek']) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /allowlist/)
  })

  test('a bare `dek` column is a violation', ({ assert }) => {
    const problems = auditWrappedDekTable([
      { path: PATH, source: migration([...ALLOWED_COLUMNS, 'dek']) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /'dek'/)
  })

  test('a missing allowlisted column is a violation', ({ assert }) => {
    const problems = auditWrappedDekTable([
      { path: PATH, source: migration(ALLOWED_COLUMNS.filter((c) => c !== 'wrapped_dek')) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /missing/)
  })

  test('the allowlist has no plaintext-DEK column name', ({ assert }) => {
    assert.isFalse(ALLOWED_COLUMNS.includes('dek'))
    assert.isTrue(ALLOWED_COLUMNS.includes('wrapped_dek'))
  })

  test('the rowscope (shared-table) allowlist adds tenant_id, still no plaintext DEK', ({
    assert,
  }) => {
    const problems = auditWrappedDekTable([
      { path: ROWSCOPE_PATH, source: migration(ROWSCOPE_ALLOWED_COLUMNS) },
    ])
    assert.deepEqual(problems, [])
    assert.isTrue(ROWSCOPE_ALLOWED_COLUMNS.includes('tenant_id'))
    assert.isFalse(ROWSCOPE_ALLOWED_COLUMNS.includes('dek'))
  })

  test('tenant_id is rowscope-only: it is NOT allowed on the per-tenant table', ({ assert }) => {
    const problems = auditWrappedDekTable([
      { path: PATH, source: migration([...ALLOWED_COLUMNS, 'tenant_id']) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /'tenant_id'/)
  })

  test('the rowscope table missing tenant_id is a violation', ({ assert }) => {
    const problems = auditWrappedDekTable([
      { path: ROWSCOPE_PATH, source: migration(ALLOWED_COLUMNS) },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /tenant_id.*missing|missing.*tenant_id/)
  })

  // `bytea` is the natural Postgres type for raw key bytes; a parser blind to it would
  // let a plaintext-DEK column slip the allowlist (the hole this guard exists to close).
  for (const extra of [
    'raw_key bytea NOT NULL',
    'dek varchar(64) NOT NULL',
    'dek character varying',
  ]) {
    test(`a plaintext-key column typed \`${extra}\` is caught (not skipped by the type parser)`, ({
      assert,
    }) => {
      const problems = auditWrappedDekTable([
        { path: ROWSCOPE_PATH, source: migrationWithExtra(ROWSCOPE_ALLOWED_COLUMNS, extra) },
      ])
      assert.isAbove(problems.length, 0)
      assert.isTrue(
        problems.some((p: string) => /not in the reviewed non-plaintext allowlist/.test(p))
      )
    })
  }

  test('the runner actually reads both wrapped-DEK migrations on disk (no dead guard)', ({
    assert,
  }) => {
    const files = discoverMigrations()
    // A real filesystem read must resolve both the per-tenant .ts and the rowscope .stub,
    // or a rename/move silently drops the allowlist review (the repo's dead-guard failure mode).
    assert.isAbove(files.length, 1)
    assert.deepEqual(missingMigrationMarkers(files), [])
  })
})

import { test } from '@japa/runner'
// The I2 guard is a repo-root script (it runs in `npm run check`); import its pure
// auditor to exercise the wrapped-DEK column allowlist: no plaintext-DEK column,
// exactly the reviewed non-plaintext set.
import {
  auditWrappedDekTable,
  ALLOWED_COLUMNS,
} from '../../../../../scripts/check-crypto-invariant-2.mjs'

const PATH = 'packages/crypto/tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts'

/** A raw CREATE TABLE body with the given columns, one `<name> text` per line. */
function migration(columns: string[]): string {
  const lines = columns.map((c) => `        ${c} text NOT NULL,`).join('\n')
  return ['this.schema.raw(`', '      CREATE TABLE ${table} (', lines, '      )`)'].join('\n')
}

test.group('architectural — I2 wrapped-DEK column allowlist', () => {
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
})

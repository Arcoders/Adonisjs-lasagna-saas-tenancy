import { test } from '@japa/runner'
import { qualifyBackofficeTable } from '../../../../src/utils/backoffice_table.js'
import { readBooleanEnvFlag } from '../../../../src/utils/env.js'

/**
 * Wave 1 / nada cableado. `qualifyBackofficeTable` is the single place raw-SQL writers
 * (WORM ledger, AI audit) turn the configured backoffice schema + a table name into a
 * SQL-safe `"schema"."table"` reference, so nobody hardcodes `backoffice.<table>` and a
 * renamed schema is honored. It MUST validate both identifiers so neither can escape
 * the quoting.
 */
test.group('qualifyBackofficeTable', () => {
  test('quotes and qualifies a normal schema + table', ({ assert }) => {
    assert.equal(qualifyBackofficeTable('backoffice', 'worm_ledger'), '"backoffice"."worm_ledger"')
    assert.equal(qualifyBackofficeTable('bo_prod', 'ai_audit_logs'), '"bo_prod"."ai_audit_logs"')
  })

  test('rejects a schema that could escape the quoting (injection)', ({ assert }) => {
    assert.throws(() => qualifyBackofficeTable('backoffice"; DROP SCHEMA x; --', 'worm_ledger'))
    assert.throws(() => qualifyBackofficeTable('bo', 'worm_ledger"; DROP TABLE y; --'))
    assert.throws(() => qualifyBackofficeTable('bo.evil', 'worm_ledger'))
    assert.throws(() => qualifyBackofficeTable('', 'worm_ledger'))
  })
})

/**
 * `readBooleanEnvFlag` is the single normalized parse for a boolean security/safety
 * toggle: true only for a clearly-affirmative value, so a case/whitespace variant is
 * honored (not silently dropped to the safe branch) while a typo or absence stays false.
 */
test.group('readBooleanEnvFlag', () => {
  const VAR = 'LASAGNA_TEST_FLAG_XYZ'
  test('true for affirmative values (case/space-insensitive)', ({ assert, cleanup }) => {
    cleanup(() => delete process.env[VAR])
    for (const v of ['true', 'TRUE', ' true ', '1', 'yes', 'on']) {
      process.env[VAR] = v
      assert.isTrue(readBooleanEnvFlag(VAR), `expected true for ${JSON.stringify(v)}`)
    }
  })

  test('false for absent, empty, negative, or typo values', ({ assert, cleanup }) => {
    cleanup(() => delete process.env[VAR])
    delete process.env[VAR]
    assert.isFalse(readBooleanEnvFlag(VAR))
    for (const v of ['', 'false', 'no', 'off', '0', 'ture', 'enabled']) {
      process.env[VAR] = v
      assert.isFalse(readBooleanEnvFlag(VAR), `expected false for ${JSON.stringify(v)}`)
    }
  })
})

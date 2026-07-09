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
 * `readBooleanEnvFlag` is the single strict parse for a SECURITY/SAFETY opt-in flag:
 * true ONLY for the exact word `true` (case/whitespace-insensitive), so a security
 * exemption (SSRF loopback, live-key-in-dev) is opened only by a deliberate,
 * unambiguous act — a stray `1`/`yes`/`on` must NOT enable it (that would be a silent
 * loosening). A typo or absence stays false.
 */
test.group('readBooleanEnvFlag', () => {
  const VAR = 'LASAGNA_TEST_FLAG_XYZ'
  test('true ONLY for the exact word true (case/space-insensitive)', ({ assert, cleanup }) => {
    cleanup(() => {
      delete process.env[VAR]
    })
    for (const v of ['true', 'TRUE', ' true ', 'True']) {
      process.env[VAR] = v
      assert.isTrue(readBooleanEnvFlag(VAR), `expected true for ${JSON.stringify(v)}`)
    }
  })

  test('false for any other value — incl. other truthy-looking ones (strict opt-in)', ({
    assert,
    cleanup,
  }) => {
    cleanup(() => {
      delete process.env[VAR]
    })
    delete process.env[VAR]
    assert.isFalse(readBooleanEnvFlag(VAR))
    // `1`/`yes`/`on` are truthy-looking but must NOT open a security exemption.
    for (const v of ['', 'false', 'no', 'off', '0', '1', 'yes', 'on', 'ture', 'enabled']) {
      process.env[VAR] = v
      assert.isFalse(readBooleanEnvFlag(VAR), `expected false for ${JSON.stringify(v)}`)
    }
  })
})

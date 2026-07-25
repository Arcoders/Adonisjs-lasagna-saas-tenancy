import { test } from '@japa/runner'
import {
  CIPHERTEXT_PREFIXES,
  encryptedColumnCheckName,
  encryptedColumnCheckPredicate,
  encryptedColumnCheckSql,
} from '../../../../src/schema/encrypted_column.js'

/**
 * The DB-level ciphertext CHECK helper: the migration SQL a host adds so a
 * non-enc_v2/enc_v1 write to an encrypted field column is refused by Postgres. This
 * closes the gap for writes the model hooks cannot see: raw SQL, the query builder,
 * and the `*Quietly` methods. These specs prove the emitted SQL and the identifier
 * guard; a real-PG spec proves the constraint actually rejects a plaintext row.
 */
test.group('behavior: encrypted-column ciphertext CHECK helper', () => {
  test('the prefixes are enc_v2/enc_v1 and share one length', ({ assert }) => {
    assert.deepEqual([...CIPHERTEXT_PREFIXES], ['enc_v2:', 'enc_v1:'])
    const lengths = new Set(CIPHERTEXT_PREFIXES.map((p) => p.length))
    assert.lengthOf([...lengths], 1)
    assert.equal([...lengths][0], 7)
  })

  test('the predicate allows NULL and any accepted prefix, slicing the fixed length', ({
    assert,
  }) => {
    const predicate = encryptedColumnCheckPredicate('passport_number')
    assert.equal(
      predicate,
      `"passport_number" IS NULL OR left("passport_number", 7) IN ('enc_v2:', 'enc_v1:')`
    )
  })

  test('the constraint name is deterministic', ({ assert }) => {
    assert.equal(
      encryptedColumnCheckName('renters', 'passport_number'),
      'renters_passport_number_is_ciphertext'
    )
  })

  test('the ALTER TABLE statement wires the name and predicate together', ({ assert }) => {
    const sql = encryptedColumnCheckSql('renters', 'passport_number')
    assert.equal(
      sql,
      `ALTER TABLE "renters" ADD CONSTRAINT "renters_passport_number_is_ciphertext" ` +
        `CHECK ("passport_number" IS NULL OR left("passport_number", 7) IN ('enc_v2:', 'enc_v1:'))`
    )
  })

  test('a caller can override the constraint name (Postgres 63-byte limit)', ({ assert }) => {
    const sql = encryptedColumnCheckSql('renters', 'passport_number', { constraintName: 'pp_enc' })
    assert.match(sql, /ADD CONSTRAINT "pp_enc" CHECK/)
  })

  test('a non-snake_case identifier is refused (no DDL injection)', ({ assert }) => {
    const bad = [
      () => encryptedColumnCheckSql('renters; DROP TABLE users', 'passport_number'),
      () => encryptedColumnCheckSql('renters', 'passport_number"); DROP TABLE users; --'),
      () => encryptedColumnCheckSql('Renters', 'passport_number'), // uppercase
      () => encryptedColumnCheckSql('renters', '1col'), // leading digit
      () => encryptedColumnCheckSql('renters', 'col-name'), // hyphen
      () => encryptedColumnCheckSql('renters', 'passport_number', { constraintName: 'bad name' }),
      () => encryptedColumnCheckPredicate('col name'),
      () => encryptedColumnCheckName('', 'col'),
    ]
    for (const call of bad) assert.throws(call, /invalid|snake_case/)
  })

  test('the table is validated even when constraintName is overridden (no ?? skip)', ({
    assert,
  }) => {
    // With an overridden constraintName the `??` short-circuits encryptedColumnCheckName,
    // where `table` would otherwise be validated; the guard must still run.
    assert.throws(
      () =>
        encryptedColumnCheckSql('renters"; DROP TABLE users; --', 'passport_number', {
          constraintName: 'pp_enc',
        }),
      /invalid|snake_case/
    )
    assert.throws(
      () => encryptedColumnCheckSql('Renters', 'passport_number', { constraintName: 'pp_enc' }),
      /invalid|snake_case/
    )
  })
})

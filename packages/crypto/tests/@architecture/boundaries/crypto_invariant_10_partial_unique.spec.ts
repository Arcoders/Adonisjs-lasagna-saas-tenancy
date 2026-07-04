import { test } from '@japa/runner'
// The I10 guard is a repo-root script; import its pure auditor to exercise the
// singular-live-DEK discipline: the wrapped-DEK table must declare a PARTIAL
// UNIQUE (subject_id, category) WHERE shredded_at IS NULL.
import { auditPartialUnique } from '../../../../../scripts/check-crypto-invariant-10.mjs'

const PATH = 'packages/crypto/tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts'

const PARTIAL =
  'CREATE UNIQUE INDEX t_live_subject_category ON t (subject_id, category) WHERE shredded_at IS NULL'

test.group('architectural — I10 singular live DEK (partial UNIQUE)', () => {
  test('a partial unique on the live rows passes', ({ assert }) => {
    const problems = auditPartialUnique([{ path: PATH, source: PARTIAL }])
    assert.deepEqual(problems, [])
  })

  test('no unique declaration at all is a violation', ({ assert }) => {
    const problems = auditPartialUnique([
      { path: PATH, source: 'CREATE TABLE t ( subject_id text, category text )' },
    ])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /PARTIAL/)
  })

  test('a plain (non-partial) UNIQUE (subject_id, category) is a violation', ({ assert }) => {
    const problems = auditPartialUnique([
      { path: PATH, source: 'CREATE TABLE t ( ..., UNIQUE (subject_id, category) )' },
    ])
    assert.isAbove(problems.length, 0)
    assert.isTrue(problems.some((p: string) => /non-partial/.test(p)))
  })
})

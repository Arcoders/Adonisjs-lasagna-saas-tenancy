import { test } from '@japa/runner'
// The I10 guard is a repo-root script; import its pure auditors to exercise the
// singular-live-DEK discipline: the wrapped-DEK table must declare a PARTIAL
// UNIQUE (subject_id, category) WHERE shredded_at IS NULL, AND the provision + shred
// paths must run under the per-tenant operation lock (#locked(...)).
import {
  auditPartialUnique,
  auditOperationLock,
  discoverMigrations,
  missingMigrationMarkers,
} from '../../../../../scripts/check-crypto-invariant-10.mjs'

const PATH = 'packages/crypto/tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts'
const ROWSCOPE_PATH = 'packages/crypto/stubs/migrations/create_crypto_wrapped_deks_rowscope.stub'
const SERVICE = 'packages/crypto/src/services/crypto_service.ts'

const PARTIAL =
  'CREATE UNIQUE INDEX t_live_subject_category ON t (subject_id, category) WHERE shredded_at IS NULL'
const PARTIAL_ROWSCOPE =
  'CREATE UNIQUE INDEX t_live ON t (tenant_id, subject_id, category) WHERE shredded_at IS NULL'

/** A service whose shred + provision paths both run under the lock (compliant). */
const LOCKED_SERVICE = [
  'export default class CryptoService {',
  '  async shred(tenant, s, c) {',
  '    if (!this.#erasabilityResolver) throw new Error()',
  '    return this.#locked(tenant.id, async () => { await this.#store.shredLive(tenant, s, c) })',
  '  }',
  '  async #provisionUnderLock(tenant, s, c) {',
  '    return this.#locked(tenant.id, async () => this.#provisionDek(tenant, s, c))',
  '  }',
  '}',
].join('\n')

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

  test('the rowscope table with a per-(tenant, subject, category) partial unique passes', ({
    assert,
  }) => {
    const problems = auditPartialUnique([{ path: ROWSCOPE_PATH, source: PARTIAL_ROWSCOPE }])
    assert.deepEqual(problems, [])
  })

  test('the rowscope table with only a (subject_id, category) unique is a violation', ({
    assert,
  }) => {
    // Under the shared table a global (subject, category) unique would let one tenant
    // block another; the live DEK must be singular per (tenant_id, subject_id, category).
    const problems = auditPartialUnique([{ path: ROWSCOPE_PATH, source: PARTIAL }])
    assert.isAbove(problems.length, 0)
    assert.isTrue(problems.some((p: string) => /tenant_id, subject_id, category/.test(p)))
  })

  test('a comment MENTIONING a (subject_id, category) unique does not trip the scan', ({
    assert,
  }) => {
    const source = [
      '/**',
      ' * The partial UNIQUE is per-(tenant_id, subject_id, category), not just',
      ' * (subject_id, category) — a global one would let a tenant block another.',
      ' */',
      PARTIAL_ROWSCOPE,
    ].join('\n')
    const problems = auditPartialUnique([{ path: ROWSCOPE_PATH, source }])
    assert.deepEqual(problems, [])
  })

  test('a rogue non-partial UNIQUE immediately after a valid partial one is still flagged', ({
    assert,
  }) => {
    // Zero-gap adjacency: the per-statement scan must not let the first index's trailing
    // window swallow the second `CREATE UNIQUE INDEX ... (subject_id, category)`.
    const source = `${PARTIAL_ROWSCOPE};\nCREATE UNIQUE INDEX b ON t (subject_id, category)`
    const problems = auditPartialUnique([{ path: ROWSCOPE_PATH, source }])
    assert.isTrue(problems.some((p: string) => /non-partial/.test(p)))
  })

  test('the runner actually reads both wrapped-DEK migrations on disk (no dead guard)', ({
    assert,
  }) => {
    const files = discoverMigrations()
    assert.isAbove(files.length, 1)
    assert.deepEqual(missingMigrationMarkers(files), [])
  })

  test('shred + provision under the per-tenant lock passes the lock discipline', ({ assert }) => {
    const problems = auditOperationLock([{ path: SERVICE, source: LOCKED_SERVICE }])
    assert.deepEqual(problems, [])
  })

  test('a shred that does NOT take the lock is a violation', ({ assert }) => {
    const source = LOCKED_SERVICE.replace(
      'return this.#locked(tenant.id, async () => { await this.#store.shredLive(tenant, s, c) })',
      'await this.#store.shredLive(tenant, s, c)'
    )
    const problems = auditOperationLock([{ path: SERVICE, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /shred\(\.\.\.\) must run under the per-tenant operation lock/)
  })

  test('a provision that does NOT take the lock is a violation', ({ assert }) => {
    const source = LOCKED_SERVICE.replace(
      'return this.#locked(tenant.id, async () => this.#provisionDek(tenant, s, c))',
      'return this.#provisionDek(tenant, s, c)'
    )
    const problems = auditOperationLock([{ path: SERVICE, source }])
    assert.lengthOf(problems, 1)
    assert.match(problems[0], /#provisionUnderLock/)
  })
})

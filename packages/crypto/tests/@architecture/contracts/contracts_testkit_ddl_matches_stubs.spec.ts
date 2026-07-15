import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The crypto real-Postgres integration helper (`tests/helpers/real_crypto_pg.ts`)
 * provisions three tables the kit bootstrap does NOT own, so their DDL is mirrored
 * from the shipped migrations. There is no single runtime source (two of the three
 * ship as host-owned migration stubs a host copies + edits, and the per-tenant one
 * ships raw SQL the crypto security guards audit in place), so this guard pins each
 * mirror to its source the same way core's `behavior_bootstrap_ddl_drift` pins the
 * backoffice mirror:
 *
 *   - the per-tenant wrapped-DEK table
 *     (`tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts`),
 *   - the rowscope shared wrapped-DEK table + its RLS policy
 *     (`stubs/migrations/create_crypto_wrapped_deks_rowscope.stub`), and
 *   - the shared `backoffice.worm_ledger` table + its append-only triggers
 *     (core's `stubs/migrations/create_worm_ledger_table.stub`).
 *
 * When this fails, a source gained/renamed a column or changed a policy/trigger and
 * `real_crypto_pg.ts` was not updated to match, so the integration tier would run
 * against a stale shape and its guarantees would be proven against the wrong table.
 */

const HELPER = fileURLToPath(new URL('../../helpers/real_crypto_pg.ts', import.meta.url))
const PER_TENANT_MIGRATION = fileURLToPath(
  new URL(
    '../../../tenant_migrations/1751500000000_create_crypto_wrapped_deks_table.ts',
    import.meta.url
  )
)
const ROWSCOPE_STUB = fileURLToPath(
  new URL('../../../stubs/migrations/create_crypto_wrapped_deks_rowscope.stub', import.meta.url)
)
const WORM_STUB = fileURLToPath(
  new URL('../../../../core/stubs/migrations/create_worm_ledger_table.stub', import.meta.url)
)

/** Column names from a raw-SQL `CREATE TABLE (...)` body (skips CONSTRAINT lines). */
function rawSqlColumns(source: string): string[] {
  const body = source.match(/CREATE TABLE\s+\S+\s*\(([\s\S]*?)\n\s*\)/)?.[1] ?? ''
  const types = 'uuid|text|char|bigint|integer|boolean|jsonb|timestamptz|date|varchar'
  const col = new RegExp(`^\\s*([a-z_]+)\\s+(?:${types})`, 'gim')
  return [...body.matchAll(col)].map((m) => m[1]).filter((c) => c !== 'constraint')
}

/** Column names a Lucid schema-builder stub defines in its up() body. */
function schemaBuilderColumns(source: string): string[] {
  const up = source.split(/async up\(\)/)[1]?.split(/async down\(\)/)[0] ?? ''
  const methods = 'uuid|string|text|boolean|jsonb|integer|bigInteger|specificType|timestamp|date'
  const col = new RegExp(`table\\.(?:${methods})\\('([a-z_]+)'`, 'g')
  return [...up.matchAll(col)].map((m) => m[1])
}

interface AssertLike {
  includeMembers(superset: string[], subset: string[], message: string): void
  match(value: string, regex: RegExp, message: string): void
}

/** Every column `expected` defines must appear as a whole word in `mirror`. */
function assertMirrored(
  assert: AssertLike,
  expected: string[],
  sample: string[],
  mirror: string,
  what: string
): void {
  assert.includeMembers(expected, sample, `${what} parse looks wrong — check the regex`)
  for (const column of expected) {
    assert.match(
      mirror,
      new RegExp(`\\b${column}\\b`),
      `${what} defines "${column}" but tests/helpers/real_crypto_pg.ts does not mirror it`
    )
  }
}

test.group('crypto test-kit DDL stays in sync with the shipped migrations', () => {
  test('the per-tenant wrapped-DEK migration matches the integration helper', ({ assert }) => {
    const helper = readFileSync(HELPER, 'utf8')
    const migration = readFileSync(PER_TENANT_MIGRATION, 'utf8')

    assertMirrored(
      assert,
      rawSqlColumns(migration),
      ['id', 'subject_id', 'category', 'wrapped_dek', 'kek_id', 'shredded_at'],
      helper,
      'the per-tenant wrapped-DEK migration'
    )

    // The per-tenant partial UNIQUE keys on (subject_id, category) with NO tenant_id
    // (that is the rowscope variant). Both sides must carry it verbatim.
    const partial = '(subject_id, category) WHERE shredded_at IS NULL'
    assert.include(migration, partial, 'per-tenant migration lost its partial UNIQUE')
    assert.include(helper, partial, 'real_crypto_pg.ts lost the per-tenant partial UNIQUE')
  })

  test('the rowscope stub table + RLS matches the integration helper', ({ assert }) => {
    const helper = readFileSync(HELPER, 'utf8')
    const stub = readFileSync(ROWSCOPE_STUB, 'utf8')

    assertMirrored(
      assert,
      rawSqlColumns(stub),
      ['tenant_id', 'subject_id', 'category', 'wrapped_dek', 'kek_id', 'shredded_at'],
      helper,
      'the rowscope stub'
    )

    // The RLS policy the store's rls branch depends on: both sides must enable +
    // force RLS, read the same GUC (`app.tenant_id`), and use the same
    // nullif(current_setting(...)) predicate. The stub interpolates the GUC via a
    // `${GUC}` constant, so match the value + the predicate shape, not the whole
    // literal clause.
    const rlsFragments = [
      'ENABLE ROW LEVEL SECURITY',
      'FORCE ROW LEVEL SECURITY',
      'app.tenant_id',
      'nullif(current_setting(',
    ]
    for (const fragment of rlsFragments) {
      assert.include(stub, fragment, `rowscope stub lost RLS fragment: ${fragment}`)
      assert.include(helper, fragment, `real_crypto_pg.ts lost RLS fragment: ${fragment}`)
    }
  })

  test('the core WORM-ledger stub table + append-only triggers match the integration helper', ({
    assert,
  }) => {
    const helper = readFileSync(HELPER, 'utf8')
    const stub = readFileSync(WORM_STUB, 'utf8')

    assertMirrored(
      assert,
      schemaBuilderColumns(stub),
      ['id', 'tenant_id', 'seq', 'checksum', 'prev_checksum', 'action', 'occurred_at'],
      helper,
      'the worm_ledger stub'
    )

    // The append-only enforcement: the trigger function + the three triggers must
    // exist on both sides, else the helper provisions a mutable ledger and the
    // append-only specs pass vacuously.
    const triggerFragments = [
      'worm_ledger_no_mutate',
      'worm_ledger_no_update',
      'worm_ledger_no_delete',
      'worm_ledger_no_truncate',
      'worm_ledger is append-only',
    ]
    for (const fragment of triggerFragments) {
      assert.include(stub, fragment, `worm stub lost trigger fragment: ${fragment}`)
      assert.include(helper, fragment, `real_crypto_pg.ts lost trigger fragment: ${fragment}`)
    }
  })
})

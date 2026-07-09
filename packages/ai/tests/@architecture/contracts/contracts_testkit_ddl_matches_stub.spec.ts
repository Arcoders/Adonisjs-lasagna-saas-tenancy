import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * The AI real-Postgres audit helper (`tests/helpers/real_audit_pg.ts`) provisions
 * the append-only `backoffice.ai_audit_logs` table + its trigger set inline (the
 * kit bootstrap does not own it, and the table is append-only so it cannot be
 * truncated between groups — each spec drops + recreates it). That inline DDL
 * mirrors the shipped migration stub, so this guard pins the two together the same
 * way core's `behavior_bootstrap_ddl_drift` pins the backoffice mirror: every
 * column the stub defines, and the append-only trigger set, must appear in the
 * helper. When it fails, the stub changed and the helper did not — so the audit
 * integration tier would run against a stale shape.
 */

const HELPER = fileURLToPath(new URL('../../helpers/real_audit_pg.ts', import.meta.url))
const STUB = fileURLToPath(
  new URL('../../../stubs/migrations/create_ai_audit_logs_table.stub', import.meta.url)
)

const COLUMN_METHODS = [
  'uuid',
  'string',
  'text',
  'boolean',
  'jsonb',
  'integer',
  'bigInteger',
  'specificType',
  'timestamp',
  'date',
  'datetime',
]
function schemaBuilderColumns(source: string): string[] {
  const up = source.split(/async up\(\)/)[1]?.split(/async down\(\)/)[0] ?? ''
  const col = new RegExp(`table\\.(?:${COLUMN_METHODS.join('|')})\\('([a-z_]+)'`, 'g')
  return [...up.matchAll(col)].map((m) => m[1])
}

test.group('AI test-kit DDL stays in sync with the shipped migration stub', () => {
  test('the ai_audit_logs stub table + append-only triggers match the integration helper', ({
    assert,
  }) => {
    const stub = readFileSync(STUB, 'utf8')
    const helper = readFileSync(HELPER, 'utf8')

    const columns = schemaBuilderColumns(stub)
    assert.includeMembers(
      columns,
      ['id', 'tenant_id', 'seq', 'checksum', 'op', 'outcome', 'principal_hash', 'occurred_at'],
      'ai_audit_logs stub parse looks wrong — check the schema-builder regex'
    )
    for (const column of columns) {
      assert.match(
        helper,
        new RegExp(`\\b${column}\\b`),
        `the ai_audit_logs stub defines "${column}" but tests/helpers/real_audit_pg.ts does not mirror it`
      )
    }

    const triggerFragments = [
      'ai_audit_logs_no_mutate',
      'ai_audit_logs_no_update',
      'ai_audit_logs_no_delete',
      'ai_audit_logs_no_truncate',
      'ai_audit_logs is append-only',
    ]
    for (const fragment of triggerFragments) {
      assert.include(stub, fragment, `ai_audit_logs stub lost trigger fragment: ${fragment}`)
      assert.include(helper, fragment, `real_audit_pg.ts lost trigger fragment: ${fragment}`)
    }
  })
})

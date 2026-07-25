import { test } from '@japa/runner'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import AiAuditReader, { type AiAuditReaderDeps } from '../../../../src/services/ai_audit_reader.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import { MAX_AI_AUDIT_PAGE, MAX_AI_AUDIT_PAGE_SIZE } from '../../../../src/constants.js'

/**
 * The audit reader stays tenant-isolated: it re-asserts scope before any raw read,
 * runs SELECT-only over the chain table, clamps pagination against OFFSET-DoS, and
 * binds every filter with `?` so a hostile principalHash matches zero rows rather than
 * the whole table. Its `(tenant_id, seq)` keyset export streams in chain order.
 */

interface FakeOpts {
  activeScope?: string
  /** Successive pages the log SELECT returns (one per rawQuery call). */
  pages?: Array<Array<Record<string, unknown>>>
  /** Rows the checkpoint SELECT returns. */
  checkpoints?: Array<Record<string, unknown>>
}

function dbRow(tenantId: string, seq: number, over: Record<string, unknown> = {}) {
  return {
    id: `id-${tenantId}-${seq}`,
    tenant_id: tenantId,
    seq,
    checksum: `sum-${seq}`,
    prev_checksum: seq === 1 ? null : `sum-${seq - 1}`,
    op: 'chat',
    outcome: 'completed',
    reason: null,
    principal_hash: 'a'.repeat(64),
    source_hash: null,
    provider: 'claude',
    model: 'm',
    tokens: 1,
    fragments: 1,
    embeddings_count: 0,
    dimension: 0,
    match_count: 0,
    idempotent_replay: false,
    occurred_at: '2026-07-03T12:00:00.000Z',
    ...over,
  }
}

interface FakeReaderClient {
  rawQuery(
    sql: string,
    bindings?: readonly unknown[]
  ): Promise<{ rows: Array<Record<string, unknown>> }>
  transaction<T>(cb: (c: FakeReaderClient) => Promise<T>): Promise<T>
}

function fakeReader(opts: FakeOpts = {}) {
  const queries: Array<{ sql: string; bindings: readonly unknown[] }> = []
  const pages = [...(opts.pages ?? [[]])]
  const client: FakeReaderClient = {
    async rawQuery(sql, bindings = []) {
      const flat = sql.replace(/\s+/g, ' ').trim()
      queries.push({ sql: flat, bindings })
      const s = flat.toLowerCase()
      if (s.includes('ai_audit_checkpoints')) {
        const all = opts.checkpoints ?? []
        if (s.includes('where tenant_id')) {
          const tid = bindings[0]
          return { rows: all.filter((r) => String(r.tenant_id) === String(tid)) }
        }
        return { rows: all }
      }
      return { rows: pages.shift() ?? [] }
    },
    async transaction(cb) {
      return cb(client)
    },
  }
  const deps: AiAuditReaderDeps = {
    getDb: async () => ({ connection: () => client }),
    connectionName: 'backoffice',
    schemaName: 'backoffice',
    activeScopeTenantId: () => opts.activeScope,
  }
  return { reader: new AiAuditReader(deps), queries }
}

test.group('AiAuditReader: scope isolation', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []
  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (p) => {
      captured.push(p)
    })
  })
  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('a bound tenantId disagreeing with the active scope trips ai_scope_mismatch', async ({
    assert,
  }) => {
    const { reader } = fakeReader({ activeScope: 'A' })
    let threw: unknown
    try {
      await reader.query({ tenantId: 'B' })
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'tenant_scope_mismatch')
    await new Promise<void>((r) => setImmediate(r))
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.id, 'guard.ai_scope_mismatch')
    // The active (own) scope is carried, never the foreign requested id.
    assert.equal(captured[0]!.tenantId, 'A')
  })

  test('an all-tenants read under a bound scope is refused (only the admin no-scope path allows it)', async ({
    assert,
  }) => {
    const { reader } = fakeReader({ activeScope: 'A' })
    await assert.rejects(() => reader.query({}), /active tenancy scope/)
  })

  test('a read of the active tenant passes; a no-scope all-tenants read passes', async ({
    assert,
  }) => {
    await assert.doesNotReject(() =>
      fakeReader({ activeScope: 'A' }).reader.query({ tenantId: 'A' })
    )
    await assert.doesNotReject(() => fakeReader({}).reader.query({}))
  })
})

test.group('AiAuditReader: SELECT-only, clamped, ?-bound', () => {
  test('query emits a single SELECT with no INSERT/UPDATE/DELETE', async ({ assert }) => {
    const { reader, queries } = fakeReader()
    await reader.query({})
    assert.lengthOf(queries, 1)
    assert.match(queries[0]!.sql.toLowerCase(), /^select /)
    assert.notMatch(queries[0]!.sql, /\b(insert|update|delete)\b/i)
  })

  test('limit and page are clamped to their ceilings (OFFSET-DoS bound)', async ({ assert }) => {
    const { reader, queries } = fakeReader()
    await reader.query({ limit: 9_999, page: 999_999 })
    const bindings = queries[0]!.bindings
    // The trailing two binds are LIMIT then OFFSET.
    assert.equal(bindings[bindings.length - 2], MAX_AI_AUDIT_PAGE_SIZE)
    assert.equal(bindings[bindings.length - 1], (MAX_AI_AUDIT_PAGE - 1) * MAX_AI_AUDIT_PAGE_SIZE)
  })

  test('every filter is ?-bound: a hostile principalHash matches zero rows, not the table', async ({
    assert,
  }) => {
    const { reader, queries } = fakeReader()
    const hostile = "x' OR '1'='1"
    await reader.query({
      tenantId: 't1',
      op: 'chat',
      outcome: 'completed',
      principalHash: hostile,
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T00:00:00.000Z',
    })
    const { sql, bindings } = queries[0]!
    for (const frag of [
      'tenant_id = ?',
      'op = ?',
      'outcome = ?',
      'principal_hash = ?',
      'occurred_at >= ?',
      'occurred_at <= ?',
    ]) {
      assert.include(sql, frag)
    }
    assert.include(bindings as unknown[], hostile, 'the hostile value is a bound value')
    assert.notInclude(sql, hostile, 'and never concatenated into the SQL')
  })

  test('a malformed op is dropped, never concatenated (the union is closed)', async ({
    assert,
  }) => {
    const { reader, queries } = fakeReader()
    await reader.query({ op: 'evil' as never })
    assert.notInclude(queries[0]!.sql, 'op = ?')
  })
})

test.group('AiAuditReader: keyset export + checkpoints', () => {
  test('exportStream pages by (tenant_id, seq) keyset in chain order', async ({ assert }) => {
    const { reader, queries } = fakeReader({
      pages: [[dbRow('t1', 1), dbRow('t1', 2)], [dbRow('t1', 3)]],
    })
    const seqs: number[] = []
    for await (const batch of reader.exportStream({}, 2)) {
      for (const e of batch) seqs.push(e.seq)
    }
    assert.deepEqual(seqs, [1, 2, 3])
    // The first page has no cursor; the second is a keyset continuation.
    assert.notInclude(queries[0]!.sql, '(tenant_id, seq) >')
    assert.include(queries[1]!.sql, '(tenant_id, seq) >')
    assert.match(queries[0]!.sql, /order by tenant_id asc, seq asc/i)
  })

  test('readCheckpoint returns a tenant seed; writeCheckpoint upserts additively (never a chain row)', async ({
    assert,
  }) => {
    const { reader } = fakeReader({
      checkpoints: [{ tenant_id: 't1', last_seq: 5, last_checksum: 'abc' }],
    })
    assert.deepEqual(await reader.readCheckpoint('t1'), { seq: 5, checksum: 'abc' })
    assert.isUndefined(await reader.readCheckpoint('nope'))

    const { reader: w, queries } = fakeReader()
    await w.writeCheckpoint('t1', 9, 'def')
    const insert = queries.find((q) => /insert into/i.test(q.sql))!
    assert.include(insert.sql.toLowerCase(), 'ai_audit_checkpoints')
    assert.include(insert.sql.toLowerCase(), 'on conflict')
    assert.notInclude(insert.sql.toLowerCase(), 'ai_audit_logs')
    assert.deepEqual(insert.bindings, ['t1', 9, 'def'])
  })
})

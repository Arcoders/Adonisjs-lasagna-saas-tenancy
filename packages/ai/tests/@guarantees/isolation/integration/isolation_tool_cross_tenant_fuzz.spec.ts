import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService from '../../../../src/services/tool_executor.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../../src/define_config.js'

/**
 * A property-based cross-tenant fuzz over TOOL EXECUTION, mirroring
 * `isolation_ai_cross_tenant_fuzz`: N tenants' tool calls interleaved under bounded
 * concurrency in a deterministically-shuffled order, each proving it read only its
 * own schema. One foreign row fails the run.
 *
 * This is the shape a unit test cannot reach. Scoping rides an `AsyncLocalStorage`,
 * and ALS is exactly what breaks under concurrent async work: a bind that leaks
 * across an await, a handler that resumes on another call's context, a `finally` that
 * unbinds the wrong frame. With one call at a time everything looks correct. The
 * interleaving is the test.
 *
 * Every call also re-reads the ambient scope INSIDE the handler, after real awaits
 * against a real database, so a scope that survives the bind but is lost across the
 * query round-trip is caught rather than silently returning empty.
 */
const N = 6
const PER = 8
const CONCURRENCY = 12
const suffix = randomUUID().replace(/-/g, '').slice(0, 12)

const tenants = Array.from({ length: N }, (_, i) => ({
  i,
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_toolfuzz_${i}_${suffix}`,
  conn: `ai_toolfuzz_conn_${i}_${suffix}`,
  secret: `secret-of-tenant-${i}`,
}))

let ready = false

const als = new AsyncLocalStorage<string>()
const byId = new Map(tenants.map((t) => [t.tenant.id, t]))
const ctx = {} as unknown as HttpContext

/** Deterministic mulberry32, so a failing interleaving reproduces from the seed. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** In-place deterministic Fisher-Yates. */
function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[items[i], items[j]] = [items[j]!, items[i]!]
  }
  return items
}

async function runBounded<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let idx = 0
  async function worker(): Promise<void> {
    while (idx < items.length) {
      const item = items[idx++]!
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

/** Reads the tenant's own row, resolving its connection from the AMBIENT scope only. */
const readSecret: AIToolHostDefinition = {
  name: 'read_secret',
  description: 'read this tenant secret',
  inputSchema: { type: 'object', properties: {} },
  mode: 'read',
  handler: async () => {
    const beforeAwait = als.getStore()
    const realm = beforeAwait ? byId.get(beforeAwait) : undefined
    if (!realm) throw new Error(`no ambient scope in the handler (got ${String(beforeAwait)})`)

    const rows = await db.connection(realm.conn).rawQuery('SELECT secret FROM tool_secrets')

    // The scope must still be THIS call's after a real async round-trip.
    const afterAwait = als.getStore()
    if (afterAwait !== beforeAwait) {
      throw new Error(`the ambient scope changed across an await: ${beforeAwait} -> ${afterAwait}`)
    }
    return { scope: beforeAwait, secret: (rows.rows as { secret: string }[])[0]?.secret }
  },
}

const toolsConfig: AIToolsConfig = {
  registry: [readSecret],
  authorizeTool: () => ({ kind: 'allow' }),
}

const service = () =>
  new ToolExecutorService({
    runScoped: (tenant, fn) => als.run(tenant.id, fn),
    activeScopeTenantId: () => als.getStore(),
    getToolsConfig: () => toolsConfig,
  })

test.group('tool cross-tenant fuzz (real Postgres, interleaved)', (group) => {
  group.setup(async () => {
    const primary = getConfig().centralConnectionName
    const client = db.connection(primary)
    try {
      await client.rawQuery('SELECT 1')
    } catch {
      ready = false
      return async () => {}
    }
    ready = true

    const template = db.manager.get(primary)?.config
    for (const t of tenants) {
      db.manager.add(t.conn, { ...template, searchPath: [t.schema] } as never)
      await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${t.schema}"`)
      await db
        .connection(t.conn)
        .rawQuery(`CREATE TABLE IF NOT EXISTS "${t.schema}".tool_secrets (secret text)`)
      await db
        .connection(t.conn)
        .rawQuery(`INSERT INTO "${t.schema}".tool_secrets (secret) VALUES (?)`, [t.secret])
    }

    return async () => {
      const cleanup = db.connection(primary)
      for (const t of tenants) {
        await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${t.schema}" CASCADE`).catch(() => {})
        if (db.manager.has(t.conn)) await db.manager.release(t.conn)
      }
    }
  })

  test('N tenants x PER interleaved tool calls never surface a foreign row', async ({ assert }) => {
    const rng = mulberry32(0xf00d)
    type Op = { i: number; j: number }
    const work: Op[] = []
    for (const t of tenants) {
      for (let j = 0; j < PER; j++) work.push({ i: t.i, j })
    }
    shuffle(work, rng)

    const svc = service()
    const failures: string[] = []
    const seen: { tenantId: string; secret: string }[] = []

    await runBounded(work, CONCURRENCY, async (op) => {
      const t = tenants[op.i]!
      const turn = await svc
        .forRequest(ctx, t.tenant, [readSecret])
        .execute(
          { id: `c-${op.i}-${op.j}`, name: 'read_secret', arguments: '{}' },
          new AbortController().signal,
          1
        )

      const payload = JSON.parse(
        turn.content.replace('<tool_result>', '').replace('</tool_result>', '')
      ) as { scope: string; secret: string }

      if (payload.scope !== t.tenant.id) {
        failures.push(`op ${op.i}/${op.j}: bound scope ${payload.scope}, expected ${t.tenant.id}`)
      }
      if (payload.secret !== t.secret) {
        failures.push(`op ${op.i}/${op.j}: read "${payload.secret}", expected "${t.secret}"`)
      }
      seen.push({ tenantId: t.tenant.id, secret: payload.secret })
    })

    assert.deepEqual(failures, [], `cross-tenant bleed under interleaving:\n${failures.join('\n')}`)
    assert.lengthOf(seen, N * PER, 'every scheduled call ran')

    // Read-back: no tenant ever saw any other tenant's secret, across the whole run.
    for (const t of tenants) {
      const mine = seen.filter((s) => s.tenantId === t.tenant.id)
      const foreign = mine.filter((s) => s.secret !== t.secret)
      assert.lengthOf(foreign, 0, `tenant ${t.i} saw a foreign secret`)
    }
  }).skip(() => !ready, 'Postgres unavailable')

  test('concurrent calls for DIFFERENT tenants started together stay separated', async ({
    assert,
  }) => {
    // The tightest interleaving: every tenant's call in flight at the same instant,
    // started from one synchronous frame. If a bind leaked, these would collide.
    const svc = service()
    const results = await Promise.all(
      tenants.map((t) =>
        svc
          .forRequest(ctx, t.tenant, [readSecret])
          .execute(
            { id: `sim-${t.i}`, name: 'read_secret', arguments: '{}' },
            new AbortController().signal,
            1
          )
          .then((turn) => ({
            expected: t.secret,
            payload: JSON.parse(
              turn.content.replace('<tool_result>', '').replace('</tool_result>', '')
            ) as { secret: string },
          }))
      )
    )

    for (const r of results) {
      assert.equal(r.payload.secret, r.expected)
    }
    assert.isUndefined(als.getStore(), 'no scope survived the concurrent batch')
  }).skip(() => !ready, 'Postgres unavailable')
})

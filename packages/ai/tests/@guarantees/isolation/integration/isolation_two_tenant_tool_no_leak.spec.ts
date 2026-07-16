import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService from '../../../../src/services/tool_executor.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../../src/define_config.js'

/**
 * The I7 proof on a REAL database: two tenants in two schemas, one tool, and a
 * handler that resolves its own connection from the AMBIENT scope — exactly as a
 * `TenantBaseModel` query does. So if the executor failed to bind the scope, or bound
 * the wrong tenant, the handler would read the wrong schema and the assertion would
 * catch it. Nothing here mocks the routing.
 *
 * The `runScoped` seam is a real `AsyncLocalStorage` rather than the kernel's
 * `tenancy.run`, which additionally connects the tenant and runs the bootstrapper
 * lifecycle (the kernel's own suite proves that, and it needs provisioned tenants this
 * harness does not have). ALS is what `tenancy.run` is built on, so what is under test
 * here is the property that actually belongs to the satellite: that the executor binds
 * the scope around the handler and re-asserts it beforehand, against real async
 * boundaries and real queries.
 */

const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const A = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_tool_a_${suffix}`,
  conn: `ai_tool_conn_a_${suffix}`,
  secret: 'booking-of-A',
}
const B = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_tool_b_${suffix}`,
  conn: `ai_tool_conn_b_${suffix}`,
  secret: 'booking-of-B',
}
const REALMS = [A, B]

let ready = false

/** The ambient tenancy scope, the same shape `tenancy.run` / `tenancy.currentId` present. */
const als = new AsyncLocalStorage<string>()

const connFor = (tenantId: string) => REALMS.find((r) => r.tenant.id === tenantId)?.conn

/**
 * A tool that reads the tenant's own table. It resolves its connection from the
 * AMBIENT scope, never from a captured tenant, so it can only return the right rows
 * if the executor really bound the scope around it.
 */
const readBookings: AIToolHostDefinition = {
  name: 'read_bookings',
  description: 'read this tenant bookings',
  inputSchema: { type: 'object', properties: {} },
  mode: 'read',
  handler: async () => {
    const active = als.getStore()
    if (!active) throw new Error('the handler ran with no ambient tenancy scope')
    const conn = connFor(active)
    if (!conn) throw new Error(`no connection for the active scope ${active}`)
    const rows = await db.connection(conn).rawQuery('SELECT reference FROM tool_rows ORDER BY 1')
    return { rows: (rows.rows as { reference: string }[]).map((r) => r.reference) }
  },
}

const toolsConfig: AIToolsConfig = {
  registry: [readBookings],
  authorizeTool: () => ({ kind: 'allow' }),
}
const ctx = {} as unknown as HttpContext

function executorService(): ToolExecutorService {
  return new ToolExecutorService({
    runScoped: (tenant, fn) => als.run(tenant.id, fn),
    activeScopeTenantId: () => als.getStore(),
    getToolsConfig: () => toolsConfig,
  })
}

const call = { id: 'c1', name: 'read_bookings', arguments: '{}' }
const signal = () => new AbortController().signal

test.group('two-tenant tool isolation (real Postgres)', (group) => {
  group.setup(async () => {
    const primary = getConfig().centralConnectionName
    const client = db.connection(primary)
    try {
      await client.rawQuery('SELECT 1')
    } catch {
      ready = false
      return
    }
    ready = true

    const template = db.manager.get(primary)?.config
    for (const realm of REALMS) {
      db.manager.add(realm.conn, { ...template, searchPath: [realm.schema] } as never)
      await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${realm.schema}"`)
      await db
        .connection(realm.conn)
        .rawQuery(`CREATE TABLE IF NOT EXISTS "${realm.schema}".tool_rows (reference text)`)
      await db
        .connection(realm.conn)
        .rawQuery(`INSERT INTO "${realm.schema}".tool_rows (reference) VALUES (?)`, [realm.secret])
    }

    return async () => {
      const cleanup = db.connection(primary)
      for (const realm of REALMS) {
        await cleanup.rawQuery(`DROP SCHEMA IF EXISTS "${realm.schema}" CASCADE`).catch(() => {})
        if (db.manager.has(realm.conn)) await db.manager.release(realm.conn)
      }
    }
  })

  test("a tenant's tool reads its own rows and never the other tenant's", async ({ assert }) => {
    const service = executorService()

    const aResult = await service
      .forRequest(ctx, A.tenant, [readBookings])
      .execute(call, signal(), 1)
    const bResult = await service
      .forRequest(ctx, B.tenant, [readBookings])
      .execute(call, signal(), 1)

    // The result is a fenced tool turn; the rows ride inside its content.
    assert.include(aResult.content, A.secret)
    assert.notInclude(aResult.content, B.secret, "tenant A's tool must never see tenant B's rows")
    assert.include(bResult.content, B.secret)
    assert.notInclude(bResult.content, A.secret)
  }).skip(() => !ready, 'Postgres unavailable')

  test('a confused-deputy call under another tenant scope is refused before the handler', async ({
    assert,
  }) => {
    // The real I7 attack shape: an executor bound to tenant A, invoked while the
    // process is already inside tenant B's ambient scope. Serving it would read A's
    // data on B's behalf (or the reverse), so it must refuse rather than rebind.
    let ran = false
    const spy: AIToolHostDefinition = {
      ...readBookings,
      handler: async () => {
        ran = true
        return {}
      },
    }
    const service = new ToolExecutorService({
      runScoped: (tenant, fn) => als.run(tenant.id, fn),
      activeScopeTenantId: () => als.getStore(),
      getToolsConfig: () => ({ registry: [spy], authorizeTool: () => ({ kind: 'allow' }) }),
    })

    let caught: unknown
    await als.run(B.tenant.id, async () => {
      try {
        await service.forRequest(ctx, A.tenant, [spy]).execute(call, signal(), 1)
      } catch (error) {
        caught = error
      }
    })

    assert.instanceOf(caught, AIException)
    assert.equal((caught as AIException).aiCode, 'tenant_scope_mismatch')
    assert.isFalse(ran, 'the handler must never run on a scope mismatch')
  }).skip(() => !ready, 'Postgres unavailable')

  test('isolation is structural: identical content in both tenants stays disjoint', async ({
    assert,
  }) => {
    // Same row text in both schemas. The tools still return only their own, because
    // the separation is the schema, not a difference in the data.
    const shared = 'identical-reference'
    for (const realm of REALMS) {
      await db
        .connection(realm.conn)
        .rawQuery(`INSERT INTO "${realm.schema}".tool_rows (reference) VALUES (?)`, [shared])
    }
    const service = executorService()

    const aRows = JSON.parse(
      (await service.forRequest(ctx, A.tenant, [readBookings]).execute(call, signal(), 1)).content
        .replace('<tool_result>', '')
        .replace('</tool_result>', '')
    ) as { rows: string[] }

    assert.include(aRows.rows, shared)
    assert.include(aRows.rows, A.secret)
    assert.notInclude(aRows.rows, B.secret)
    assert.lengthOf(aRows.rows, 2, "A sees exactly its own two rows, not B's copy")
  }).skip(() => !ready, 'Postgres unavailable')

  test('the scope is released after the call, leaving no ambient bleed', async ({ assert }) => {
    // A leaked scope would make the NEXT call read the previous tenant's schema.
    const service = executorService()
    await service.forRequest(ctx, A.tenant, [readBookings]).execute(call, signal(), 1)
    assert.isUndefined(als.getStore(), 'the tool call must not leave a scope bound behind it')
  }).skip(() => !ready, 'Postgres unavailable')
})

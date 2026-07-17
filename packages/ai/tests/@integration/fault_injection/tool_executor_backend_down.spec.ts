import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService from '../../../src/services/tool_executor.js'
import AIException from '../../../src/exceptions/ai_exception.js'
import MockAIProvider from '../../../src/testing/mock_ai_provider.js'
import { buildToolLoopProducer } from '../../../src/gateway/tool_loop.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../src/define_config.js'
import type {
  AIMessage,
  AIStreamRequest,
  AIToolDefinition,
  StreamFragment,
} from '../../../src/types/ai_provider_contract.js'

/**
 * Fault-injection tier: a tool handler's own database backend drops mid-call.
 *
 * The behavior-tier unit spec (behavior_tool_loop) proves the loop's reaction with a
 * fake executor, and the executor's own unit specs prove the degrade with a handler
 * that simply throws. This complements both against the booted app and real Postgres,
 * because the property at stake is a whole-path one: `tool_executor` runs the handler
 * in an INNER try so a handler that merely failed degrades to a bounded error result
 * instead of aborting the stream, and that only matters if the loop really carries on
 * afterwards. So the real `buildToolLoopProducer` drives a real `ToolExecutorService`
 * over a real per-tenant schema, and the handler reads its rows through a real
 * connection resolved from the ambient scope.
 *
 * The fault lands at the HANDLER's own backend seam and nowhere else: the handler
 * completes a real round trip, then its connection resets (`ECONNRESET`, the shape a
 * dropped pg socket carries, the same one crypto's keyprovider_backend_down injects),
 * and only for the tenant under test. No shared singleton is touched, so the real
 * schema, the real connection and the other tenant are all still there to assert on
 * afterwards. Every schema and connection name is derived from a per-run `suffix` and
 * only those are dropped, because a fault teardown that reaches for a shared name
 * collides with whatever else is on the local database.
 */

const suffix = randomUUID().replace(/-/g, '').slice(0, 12)
const A = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_fault_a_${suffix}`,
  conn: `ai_fault_conn_a_${suffix}`,
  secret: 'booking-of-A',
}
const B = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_fault_b_${suffix}`,
  conn: `ai_fault_conn_b_${suffix}`,
  secret: 'booking-of-B',
}
const REALMS = [A, B]

let ready = false

/** The tenant whose handler backend is currently unreachable. Undefined ⇒ everyone is healthy. */
let backendDownFor: string | undefined

/**
 * How many times the injected outage actually fired. The degrade is deliberately
 * opaque about WHY a handler failed, so without this a test would pass just as
 * happily on a handler that broke for some unrelated reason. Asserting it pins the
 * degrade to the fault this spec injected.
 */
let drops = 0

/** The ambient tenancy scope, the same shape `tenancy.run` / `tenancy.currentId` present. */
const als = new AsyncLocalStorage<string>()

const connFor = (tenantId: string) => REALMS.find((r) => r.tenant.id === tenantId)?.conn

/**
 * The handler's own database access. It opens the real connection and completes a
 * real round trip first, so the outage lands on a connection that was genuinely in
 * use rather than on a handler that never reached its backend, which is what makes
 * the "the rows are untouched" assertion mean something.
 */
async function readReferences(tenantId: string, conn: string): Promise<string[]> {
  const client = db.connection(conn)
  await client.rawQuery('SELECT 1')
  if (backendDownFor === tenantId) {
    drops += 1
    const error = new Error('read ECONNRESET') as Error & { code?: string }
    error.code = 'ECONNRESET'
    throw error
  }
  const result = await client.rawQuery('SELECT reference FROM tool_rows ORDER BY 1')
  return (result.rows as { reference: string }[]).map((row) => row.reference)
}

/** A read tool that resolves its connection from the AMBIENT scope, as a `TenantBaseModel` query does. */
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
    return { rows: await readReferences(active, conn) }
  },
}

/** What the model is offered on the wire; the executor's own set is the host definition. */
const WIRE_TOOLS: AIToolDefinition[] = [
  { name: 'read_bookings', description: 'read this tenant bookings', inputSchema: {} },
]

const toolsConfig: AIToolsConfig = {
  registry: [readBookings],
  authorizeTool: () => ({ kind: 'allow' }),
}
const ctx = {} as unknown as HttpContext

const baseRequest: AIStreamRequest = {
  messages: [{ role: 'user', content: '¿cuántas reservas tengo?' }],
}

function executorService(): ToolExecutorService {
  return new ToolExecutorService({
    runScoped: (tenant, fn) => als.run(tenant.id, fn),
    activeScopeTenantId: () => als.getStore(),
    getToolsConfig: () => toolsConfig,
  })
}

function toolCallFragment(id: string, name: string): StreamFragment {
  return { data: '', tokens: 0, event: 'tool_call', toolCall: { id, name, arguments: '{}' } }
}

/**
 * Run the REAL tool loop for a tenant: round 1 calls `name`, round 2 answers in text.
 * Consuming the producer directly is the whole loop; the spine around it only adds the
 * SSE framing, which is not what this tier is about.
 */
async function runLoop(
  realm: (typeof REALMS)[number],
  name = 'read_bookings'
): Promise<{ provider: MockAIProvider; fragments: StreamFragment[]; error: unknown }> {
  const provider = new MockAIProvider({
    name: 'claude',
    contractVersion: 2,
    rounds: [[toolCallFragment('call-1', name)], [{ data: 'tienes 1 reserva', tokens: 3 }]],
  })
  const producer = buildToolLoopProducer({
    tenantId: realm.tenant.id,
    provider,
    baseRequest,
    tools: WIRE_TOOLS,
    executor: executorService().forRequest(ctx, realm.tenant, [readBookings]),
    perRoundMaxTokens: 100,
  })

  const fragments: StreamFragment[] = []
  let error: unknown
  try {
    for await (const fragment of producer(new AbortController().signal)) fragments.push(fragment)
  } catch (caught) {
    error = caught
  }
  return { provider, fragments, error }
}

/** The `role: 'tool'` turn the loop re-injected, read off the round it was sent into. */
function toolTurnOfRound2(provider: MockAIProvider): AIMessage {
  const round2 = provider.calls[1]
  if (!round2) throw new Error('the loop never re-entered the provider for a second round')
  const turn = round2.request.messages.at(-1)
  if (!turn) throw new Error('the second round carried no messages')
  return turn
}

async function referencesIn(realm: (typeof REALMS)[number]): Promise<string[]> {
  const result = await db
    .connection(realm.conn)
    .rawQuery(`SELECT reference FROM "${realm.schema}".tool_rows ORDER BY 1`)
  return (result.rows as { reference: string }[]).map((row) => row.reference)
}

test.group('AI tool handler backend down (unreachable mid-call) on real Postgres', (group) => {
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

  group.each.setup(() => {
    backendDownFor = undefined
    drops = 0
  })

  test('a dead handler backend degrades in-band and the loop runs the next round', async ({
    assert,
  }) => {
    backendDownFor = A.tenant.id
    const { provider, fragments, error } = await runLoop(A)

    // The distinction the executor is built around: a handler that merely failed is
    // not a refusal, so the stream is never aborted.
    assert.isUndefined(error, 'an unreachable tool backend must not abort the stream')
    assert.equal(drops, 1, 'the handler must have reached its backend and lost it there')
    assert.lengthOf(provider.calls, 2, 'the loop must carry on into the next round')

    const turn = toolTurnOfRound2(provider)
    assert.equal(turn.role, 'tool')
    assert.equal(turn.toolCallId, 'call-1')
    assert.include(turn.content, 'tool_execution_failed')
    assert.match(turn.content, /^<tool_result>.*<\/tool_result>$/s, 'the degrade stays fenced')
    // The result is the bounded error object, so the backend's own error string is
    // never handed to the model (or, through it, to the client).
    assert.notInclude(turn.content, 'ECONNRESET')
    assert.notInclude(
      turn.content,
      A.secret,
      'the degrade carries the error object, not tenant rows'
    )
    assert.isBelow(turn.content.length, 200, 'the degraded result stays bounded')

    // The model still got its round-2 answer, on top of the redacted call notice.
    assert.deepInclude(fragments, { data: 'tienes 1 reserva', tokens: 3 })
    assert.isTrue(fragments.some((f) => f.event === 'tool_call'))
  }).skip(() => !ready, 'Postgres unavailable')

  test('a gate refusal, unlike a dead backend, is fatal and ends the loop', async ({ assert }) => {
    // The other side of the same split. Both reach the executor and both fail, but a
    // refusal throws (the spine renders it in-band and stops) where a broken backend
    // degrades, so the pair pins the behavior rather than one direction of it.
    const { provider, error } = await runLoop(A, 'no_such_tool')

    assert.instanceOf(error, AIException)
    assert.equal((error as AIException).aiCode, 'tool_unknown')
    assert.lengthOf(provider.calls, 1, 'a fatal refusal must not reach a second round')
  }).skip(() => !ready, 'Postgres unavailable')

  test('a failed handler is attempted exactly once, never retried behind the loop', async ({
    assert,
  }) => {
    backendDownFor = A.tenant.id
    const first = await runLoop(A)
    assert.isUndefined(first.error)
    // One drop per call and no more. A retry hidden inside the executor would double
    // whatever the handler had already done before it lost its backend, and would
    // double its audit row, so "degrade" must mean give up, not try again.
    assert.equal(drops, 1, 'a handler that lost its backend must be attempted exactly once')

    const second = await runLoop(A)
    assert.isUndefined(second.error)
    assert.equal(drops, 2, 'the second call drops once too; neither call retried')

    // The outage was the backend's, not the state's: A's own connection, the one the
    // handler was holding when it dropped, still serves A's rows afterwards.
    //
    // What this does NOT prove: the tool is `mode: 'read'` and its handler only ever
    // SELECTs, so no write was in flight and nothing here shows transactional
    // rollback. Reading the rows back could not fail whatever the executor did. The
    // row check is a liveness probe on the connection, not a containment proof; a
    // real rollback proof needs an action tool, which stays hard-gated until Phase 3a.
    assert.deepEqual(await referencesIn(A), [A.secret])
  }).skip(() => !ready, 'Postgres unavailable')

  test('the tool recovers once the backend is healthy, and the other tenant never noticed', async ({
    assert,
  }) => {
    backendDownFor = A.tenant.id
    const degraded = await runLoop(A)
    assert.include(toolTurnOfRound2(degraded.provider).content, 'tool_execution_failed')

    // Nothing shared broke, so a tenant whose backend was never down keeps reading
    // its own rows THROUGH the outage.
    const duringOutage = await runLoop(B)
    assert.include(toolTurnOfRound2(duringOutage.provider).content, B.secret)
    assert.equal(drops, 1, "only A's backend ever dropped")

    // And the same tool, same schema, same connection reads the real rows again the
    // moment the backend is back: the outage was the backend's, not the state's.
    backendDownFor = undefined
    const recovered = await runLoop(A)
    const turn = toolTurnOfRound2(recovered.provider)
    assert.include(turn.content, A.secret)
    assert.notInclude(turn.content, 'tool_execution_failed')
    assert.notInclude(turn.content, B.secret, 'recovery must not widen the scope')
    assert.equal(drops, 1, 'the recovered call reached its backend without dropping')
  }).skip(() => !ready, 'Postgres unavailable')
})

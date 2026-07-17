import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService from '../../../src/services/tool_executor.js'
import { MAX_TOOL_TIMEOUT_MS } from '../../../src/constants.js'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../src/define_config.js'

/**
 * Fault-injection tier: the client disconnects (the request AbortSignal fires)
 * while a tool handler is still running.
 *
 * The fault injected is the one the security review found and `runWithAbort` fixed:
 * `await tool.handler()` never raced the signal, so a handler that IGNORES its
 * AbortSignal pinned the single pump, its reservation and the tenant's concurrency
 * slot for as long as the handler felt like running. Every handler below therefore
 * ignores its signal completely (it awaits a gate this spec controls), which is the
 * only shape that can tell a real race apart from a handler that politely bails out
 * on its own. The behavior-tier specs already cover the degrade-vs-fatal policy with
 * doubles; what this tier adds is a real database under the handler, so the claim
 * "no orphaned work" is measured against rows rather than a spy.
 *
 * Honest about what is NOT proven here:
 *
 *  - The detached handler is NOT killed. `runWithAbort` stops WAITING for it, it
 *    cannot stop it, and this spec asserts exactly that: the late write does land,
 *    once, and simply never reaches the model. A tool that must not perform an
 *    effect after a disconnect has to inspect its own `context.signal`.
 *  - The pump, the quota reservation and the per-tenant concurrency slot are freed
 *    BECAUSE the loop awaits `executor.execute()` (tool_loop, round step 4). This
 *    spec drives the executor directly, so what it measures is that the await
 *    settles promptly. The release that follows from it belongs to the loop.
 *  - This is a per-process property. Nothing here says anything about another pod.
 *
 * Every wait is bounded. A chaos spec that can hang forever is worse than no spec,
 * so each handler is gated on an explicit deferred rather than on a timer, and each
 * assertion races the work against {@link BOUND_MS}.
 */

const suffix = randomUUID().replace(/-/g, '').slice(0, 12)

const REALM = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_fault_disc_${suffix}`,
  conn: `ai_fault_disc_conn_${suffix}`,
}

/** Markers written to the tenant's real table, one per fault we inject. */
const SEED = 'seed-row'
const LATE = 'late-detached-write'
const NEVER = 'must-never-be-written'
/** The late rejection test 3 watches for. Distinctive so a foreign rejection cannot pass for it. */
const SENTINEL = `detached-handler-rejected-${suffix}`

/**
 * The bound on every wait. Generous next to the ~ms an abort needs to settle, and far
 * under the tool timeout below, so a slow CI box cannot fail this while a genuinely
 * unraced handler still cannot pass it.
 */
const BOUND_MS = 1_500

let ready = false
/** Test 3's process-level listener, removed by the each-teardown even if the test throws. */
let rejectionListener: ((reason: unknown) => void) | undefined

/** The ambient tenancy scope, the same shape `tenancy.run` / `tenancy.currentId` present. */
const als = new AsyncLocalStorage<string>()

const ctx = {} as unknown as HttpContext
const call = { id: 'disconnect-1', name: 'slow_report', arguments: '{}' }

interface Deferred<T> {
  readonly promise: Promise<T>
  readonly resolve: (value: T) => void
  readonly reject: (error: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Race `work` against a timer and fail loudly if the timer wins. An unbounded await would hang the suite. */
async function withinBound<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not settle within ${BOUND_MS}ms`)),
      BOUND_MS
    )
  })
  try {
    return await Promise.race([work, bound])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Let Node run its rejection bookkeeping: `unhandledRejection` fires a tick after the microtasks drain. */
async function settleRejectionBookkeeping(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve))
  await new Promise<void>((resolve) => setTimeout(resolve, 20))
}

/**
 * The tools config every test runs under. `toolTimeoutMs` is pinned to the hard
 * ceiling on purpose: the per-tool deadline is the OTHER thing that can free the
 * pump, and leaving it at its 5s default would let it rescue a call this spec means
 * to see freed by the disconnect alone. At 30s, only the client disconnect can
 * settle these calls inside the bound.
 */
function toolsConfigFor(tool: AIToolHostDefinition): AIToolsConfig {
  return {
    registry: [tool],
    authorizeTool: () => ({ kind: 'allow' }),
    toolTimeoutMs: MAX_TOOL_TIMEOUT_MS,
  }
}

function executorFor(tool: AIToolHostDefinition): ToolExecutorService {
  const config = toolsConfigFor(tool)
  return new ToolExecutorService({
    runScoped: (tenant, fn) => als.run(tenant.id, fn),
    activeScopeTenantId: () => als.getStore(),
    getToolsConfig: () => config,
  })
}

/** Every marker in the tenant's real table, read back through the tenant connection. */
async function markers(): Promise<string[]> {
  const rows = await db
    .connection(REALM.conn)
    .rawQuery(`SELECT marker FROM "${REALM.schema}".tool_writes ORDER BY 1`)
  return (rows.rows as { marker: string }[]).map((row) => row.marker)
}

async function writeMarker(marker: string): Promise<void> {
  await db
    .connection(REALM.conn)
    .rawQuery(`INSERT INTO "${REALM.schema}".tool_writes (marker) VALUES (?)`, [marker])
}

test.group('client disconnects mid tool execution (real Postgres)', (group) => {
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
    db.manager.add(REALM.conn, { ...template, searchPath: [REALM.schema] } as never)
    await client.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${REALM.schema}"`)
    await db
      .connection(REALM.conn)
      .rawQuery(`CREATE TABLE IF NOT EXISTS "${REALM.schema}".tool_writes (marker text)`)

    // Only this run's own schema is dropped, never a shared one: a fault tier that
    // reaches past its own suffix collides with whatever else shares the local database.
    return async () => {
      await client.rawQuery(`DROP SCHEMA IF EXISTS "${REALM.schema}" CASCADE`).catch(() => {})
      if (db.manager.has(REALM.conn)) await db.manager.release(REALM.conn)
    }
  })

  group.each.setup(async () => {
    if (!ready) return
    await db.connection(REALM.conn).rawQuery(`DELETE FROM "${REALM.schema}".tool_writes`)
    await writeMarker(SEED)
  })

  group.each.teardown(() => {
    if (rejectionListener) process.off('unhandledRejection', rejectionListener)
    rejectionListener = undefined
  })

  test('a disconnect frees the call even though the handler ignores its signal', async ({
    assert,
  }) => {
    // THE regression. The handler never looks at `context.signal`; it sits on a gate
    // only this test can open. Before `runWithAbort` raced the signal, the await below
    // would sit there with it, holding the pump and the reservation for as long as the
    // handler ran. Now the abort settles the call and the handler is left detached.
    const started = deferred()
    const gate = deferred()
    const tool: AIToolHostDefinition = {
      name: 'slow_report',
      description: 'a slow report that never inspects its abort signal',
      inputSchema: { type: 'object', properties: {} },
      mode: 'read',
      handler: async () => {
        started.resolve()
        await gate.promise
        return { report: 'finished long after the client left' }
      },
    }

    const controller = new AbortController()
    const execution = executorFor(tool)
      .forRequest(ctx, REALM.tenant, [tool])
      .execute(call, controller.signal, 1)

    await withinBound(started.promise, 'the handler')
    controller.abort()

    const result = await withinBound(execution, 'the aborted tool call')
    assert.equal(result.role, 'tool', 'an abort degrades the call, it does not throw')
    assert.equal(result.toolCallId, call.id)
    assert.include(
      result.content,
      'tool_execution_failed',
      'the model gets a bounded error result it can react to, not a hang'
    )

    gate.resolve()
  }).skip(() => !ready, 'Postgres unavailable')

  test('the aborted call writes nothing of its own, and the detached write lands exactly once', async ({
    assert,
  }) => {
    // The handler's effect is a REAL insert, gated so it cannot happen before the
    // abort. Two separate claims, measured at two separate moments against the real
    // table: what the call itself did (nothing), and what the handler it stopped
    // waiting for eventually did (its one write, unretried and unrolled-back).
    const started = deferred()
    const gate = deferred()
    const wrote = deferred()
    const tool: AIToolHostDefinition = {
      name: 'slow_report',
      description: 'a report that writes to the tenant table after a delay',
      inputSchema: { type: 'object', properties: {} },
      mode: 'read',
      handler: async () => {
        started.resolve()
        await gate.promise
        await writeMarker(LATE)
        wrote.resolve()
        return { secret: LATE }
      },
    }

    const controller = new AbortController()
    const execution = executorFor(tool)
      .forRequest(ctx, REALM.tenant, [tool])
      .execute(call, controller.signal, 1)

    await withinBound(started.promise, 'the handler')
    controller.abort()
    const result = await withinBound(execution, 'the aborted tool call')

    // (1) At the moment the call settles, the table holds only what it held before.
    assert.deepEqual(
      await markers(),
      [SEED],
      'the aborted call must not leave a partial write behind it'
    )
    assert.notInclude(
      result.content,
      LATE,
      "the detached handler's result must never be fenced into a turn and sent to the model"
    )

    // (2) Now let the detached handler finish. Its write DOES land: the executor stopped
    //     waiting for the handler, it did not kill it, and this is the honest shape of
    //     that. What matters is that it lands exactly once (no retry, no double effect)
    //     and that the model never saw it.
    gate.resolve()
    await withinBound(wrote.promise, 'the detached handler')

    const after = await markers()
    assert.deepEqual(
      after.filter((marker) => marker === LATE),
      [LATE],
      'the detached write lands exactly once: the abort neither retried nor duplicated it'
    )
    assert.lengthOf(after, 2, 'the table is consistent: the seed row plus the one late write')
  }).skip(() => !ready, 'Postgres unavailable')

  test('a detached handler that rejects after the abort never surfaces as an unhandled rejection', async ({
    assert,
  }) => {
    // The nastier half of detaching: the handler's promise is still out there, and it
    // loses its race. If `runWithAbort` dropped it instead of consuming its settlement,
    // a handler that rejects late would take the process down under Node's default
    // unhandled-rejections mode, long after the request it belonged to was gone.
    const seen: unknown[] = []
    rejectionListener = (reason: unknown) => seen.push(reason)
    process.on('unhandledRejection', rejectionListener)

    const started = deferred()
    const gate = deferred()
    const aboutToReject = deferred()
    const tool: AIToolHostDefinition = {
      name: 'slow_report',
      description: 'a report that fails long after the client disconnected',
      inputSchema: { type: 'object', properties: {} },
      mode: 'read',
      handler: async () => {
        started.resolve()
        await gate.promise
        aboutToReject.resolve()
        throw new Error(SENTINEL)
      },
    }

    const controller = new AbortController()
    const execution = executorFor(tool)
      .forRequest(ctx, REALM.tenant, [tool])
      .execute(call, controller.signal, 1)

    await withinBound(started.promise, 'the handler')
    controller.abort()
    await withinBound(execution, 'the aborted tool call')

    // The call is long settled. NOW make the orphan blow up.
    gate.resolve()
    await withinBound(aboutToReject.promise, 'the detached handler')
    await settleRejectionBookkeeping()

    const ours = seen.filter((reason) => reason instanceof Error && reason.message === SENTINEL)
    assert.lengthOf(
      ours,
      0,
      "the detached handler's late rejection is consumed by runWithAbort, not left to the process"
    )
  }).skip(() => !ready, 'Postgres unavailable')

  test('a signal already aborted before execute never starts the handler at all', async ({
    assert,
  }) => {
    // The disconnect that beats the tool call to the punch: the client is gone by the
    // time the loop reaches this call. `composeToolSignal` inherits the aborted parent
    // and `runWithAbort` rejects before it ever invokes the handler, so the effect is
    // not merely unawaited, it never happens. The real table is the witness.
    let ran = false
    const tool: AIToolHostDefinition = {
      name: 'slow_report',
      description: 'a report that must never run for a client that already left',
      inputSchema: { type: 'object', properties: {} },
      mode: 'read',
      handler: async () => {
        ran = true
        await writeMarker(NEVER)
        return { secret: NEVER }
      },
    }

    const controller = new AbortController()
    controller.abort()

    const result = await withinBound(
      executorFor(tool).forRequest(ctx, REALM.tenant, [tool]).execute(call, controller.signal, 1),
      'the pre-aborted tool call'
    )

    assert.isFalse(ran, 'an already-aborted signal must not start the handler')
    assert.include(result.content, 'tool_execution_failed')
    assert.deepEqual(
      await markers(),
      [SEED],
      'the handler never ran, so its write never reached the tenant table'
    )
  }).skip(() => !ready, 'Postgres unavailable')
})

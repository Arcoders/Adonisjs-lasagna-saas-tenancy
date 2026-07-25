import { test } from '@japa/runner'
import TenantLivenessWatcher from '../../../../src/services/tenant_liveness_watcher.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import { buildToolChat, fakeTenant, toolChatBody } from '../../../helpers/tool_chat_doubles.js'
import { MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT } from '../../../../src/constants.js'

test.group('security: per-tenant tool-loop concurrency cap', () => {
  test('refuses the (N+1)th concurrent acquire with a 429 too_many_concurrent', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const cap = 2
    watcher.acquire('t1', { maxConcurrent: cap })
    watcher.acquire('t1', { maxConcurrent: cap })

    const err = assert.throws(
      () => watcher.acquire('t1', { maxConcurrent: cap }),
      /too many concurrent/i
    )
    assert.instanceOf(err, AIException)
    assert.equal((err as unknown as AIException).aiCode, 'too_many_concurrent')
    assert.equal((err as unknown as AIException).httpStatus, 429)
  })

  test('a refused acquire creates no handle; disposing one frees a slot', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    const cap = 2
    const h1 = watcher.acquire('t1', { maxConcurrent: cap })
    watcher.acquire('t1', { maxConcurrent: cap })

    // Refused: the in-flight count is unchanged, so a dispose still frees exactly one.
    assert.throws(() => watcher.acquire('t1', { maxConcurrent: cap }))
    h1.dispose()
    assert.doesNotThrow(() => watcher.acquire('t1', { maxConcurrent: cap }))
  })

  test('an uncapped acquire (plain chat / embed / retrieve) is never refused', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    for (let i = 0; i < 50; i++) watcher.acquire('t1')
    assert.equal(watcher.watchedTenantCount(), 1)
  })

  test('the cap is per-tenant: one tenant at its cap never blocks another', ({ assert }) => {
    const watcher = new TenantLivenessWatcher()
    watcher.acquire('a', { maxConcurrent: 1 })
    assert.throws(() => watcher.acquire('a', { maxConcurrent: 1 }), /too many concurrent/i)
    assert.doesNotThrow(() => watcher.acquire('b', { maxConcurrent: 1 }))
  })

  test('the cap gates a tool loop on TOTAL in-flight: uncapped streams count toward it', ({
    assert,
  }) => {
    // The cap deliberately reuses the shared liveness set (no new registry), so it
    // is an admission gate on the tenant's total live streams, not a tool-loop-exact
    // counter. Three uncapped streams (plain chat / embed / retrieve) already saturate
    // a cap of 3, so a NEW tool loop is refused even though no tool loop is running.
    const watcher = new TenantLivenessWatcher()
    watcher.acquire('t1')
    watcher.acquire('t1')
    watcher.acquire('t1')
    const err = assert.throws(
      () => watcher.acquire('t1', { maxConcurrent: 3 }),
      /too many concurrent AI streams/i
    )
    assert.equal((err as unknown as AIException).aiCode, 'too_many_concurrent')
    // The message does not falsely claim there are three concurrent tool loops.
    assert.notMatch((err as unknown as AIException).message, /concurrent AI tool loops/i)
  })
})

/**
 * The cap is only a rail if the controller actually passes one. A tool
 * request must acquire CAPPED and be refused pre-commit at the ceiling; a plain
 * chat must keep acquiring uncapped, so wiring the cap cannot regress ordinary
 * chat into a 429 under load.
 */
test.group('security: the chat controller wires the cap onto a tool request', () => {
  test('a tool request at the cap is refused 429 pre-commit, before any upstream call', async ({
    assert,
  }) => {
    const liveness = new TenantLivenessWatcher()
    const { controller, provider } = buildToolChat({
      liveness,
      tools: { maxConcurrentPerTenant: 1 },
    })
    // One stream of this tenant is already in flight.
    liveness.acquire(fakeTenant.id)

    const { ctx, res, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
    })
    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 429)
    assert.deepEqual(responseFacade.sentBody, { error: 'too_many_concurrent' })
    assert.isFalse(res.flushed, 'the refusal is pre-commit, so a real status reaches the client')
    assert.lengthOf(provider.calls, 0, 'a refused loop costs nothing upstream')
  })

  test('a plain chat is never capped, however busy the tenant is', async ({ assert }) => {
    const liveness = new TenantLivenessWatcher()
    const { controller, provider } = buildToolChat({
      liveness,
      toolFree: true,
      rounds: [[{ data: 'hola', tokens: 2 }]],
    })
    for (let i = 0; i < 40; i++) liveness.acquire(fakeTenant.id)

    const { ctx, res, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
    })
    await controller.chat(ctx)

    assert.isUndefined(responseFacade.sentStatus)
    assert.isTrue(res.flushed, 'plain chat streams regardless of the tenant in-flight count')
    assert.lengthOf(provider.calls, 1)
  })

  test('a tool request below the cap streams, and disposes its handle', async ({ assert }) => {
    const liveness = new TenantLivenessWatcher()
    const { controller } = buildToolChat({ liveness, tools: { maxConcurrentPerTenant: 2 } })
    liveness.acquire(fakeTenant.id).dispose()

    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })
    await controller.chat(ctx)

    assert.isTrue(res.flushed)
    assert.equal(liveness.watchedTenantCount(), 0, 'the loop released its slot')
  })

  test('a greedy maxConcurrentPerTenant is clamped to the hard ceiling', async ({ assert }) => {
    // A host asking for 9999 concurrent loops gets the ceiling, so the config can
    // never widen the rail past what the connection pool can survive.
    const liveness = new TenantLivenessWatcher()
    const { controller, provider } = buildToolChat({
      liveness,
      tools: { maxConcurrentPerTenant: 9999 },
    })
    for (let i = 0; i < MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT; i++) liveness.acquire(fakeTenant.id)

    const { ctx, responseFacade } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })
    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 429)
    assert.lengthOf(provider.calls, 0)
  })
})

import { test } from '@japa/runner'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import {
  buildToolChat,
  fakeTenant,
  mapIdempotencyStore,
  toolCallFragment,
  toolChatBody,
} from '../../../helpers/tool_chat_doubles.js'
import type { AIToolHostDefinition } from '../../../../src/define_config.js'

/**
 * The WIRING that makes the tool loop live: the chat controller
 * resolves the per-tenant registry behind the default-deny gate, advertises the
 * read subset, and drives the multi-round loop inside the SAME single pump: one
 * SSE stream, monotonic ids, one terminal `done`. The loop, the gate, the input
 * validator and the executor each have their own specs; this pins that the
 * controller composes them, and that a host without tools keeps the byte-for-byte
 * plain path.
 */

test.group('chat controller tool loop', () => {
  test('a model tool call runs the host handler and the answer streams in one SSE stream', async ({
    assert,
  }) => {
    const { controller, provider, handlerCalls } = buildToolChat()
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    // Two provider rounds: the tool call, then the grounded answer.
    assert.lengthOf(provider.calls, 2, 'the loop re-entered the provider after the tool ran')

    // The handler ran once, with the validated arguments, INSIDE tenancy.run(tenant).
    assert.lengthOf(handlerCalls, 1)
    assert.deepEqual(handlerCalls[0]!.args, { status: 'active' })
    assert.equal(handlerCalls[0]!.scopeTenantId, fakeTenant.id, 'the handler ran tenant-scoped')

    // One stream: the redacted notice, the answer, one terminal done frame.
    assert.isTrue(res.flushed)
    assert.include(res.output, 'event: tool_call\ndata: {"name":"count_bookings","id":"call-1"}')
    assert.include(res.output, 'data: tienes 4 reservas')
    assert.isTrue(res.output.endsWith('event: done\ndata: {"outcome":"completed"}\n\n'))
  })

  test('the advertised tools are the wire shape, and the tool result is re-injected fenced', async ({
    assert,
  }) => {
    const { controller, provider } = buildToolChat()
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    // Round 1 advertises the tool stripped to its wire shape, never the handler.
    const advertised = provider.calls[0]!.request.tools
    assert.lengthOf(advertised!, 1)
    assert.deepEqual(Object.keys(advertised![0]!).sort(), ['description', 'inputSchema', 'name'])
    assert.equal(advertised![0]!.name, 'count_bookings')
    assert.notProperty(advertised![0]!, 'handler')

    // Round 2 carries the accumulated turns: the assistant tool-call turn, then the
    // fenced `role: 'tool'` result. The assistant turn's calls must match the results.
    const round2 = provider.calls[1]!.request.messages
    const assistant = round2.at(-2)!
    const toolTurn = round2.at(-1)!
    assert.equal(assistant.role, 'assistant')
    assert.deepEqual(
      assistant.toolCalls?.map((c) => c.id),
      ['call-1']
    )
    assert.equal(toolTurn.role, 'tool', 'the result is an untrusted tool turn, never a system one')
    assert.equal(toolTurn.toolCallId, 'call-1')
    assert.equal(toolTurn.content, '<tool_result>{"total":4}</tool_result>')
  })

  test('the client notice redacts the tool arguments by default', async ({ assert }) => {
    const { controller } = buildToolChat({
      rounds: [
        [toolCallFragment('call-1', 'count_bookings', '{"status":"top-secret-value"}')],
        [{ data: 'listo', tokens: 1 }],
      ],
    })
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.include(res.output, 'event: tool_call')
    assert.notInclude(res.output, 'top-secret-value', 'arguments never reach the client by default')
  })

  test('surfaceToolArgs opts the arguments into the notice', async ({ assert }) => {
    const { controller } = buildToolChat({ tools: { surfaceToolArgs: true } })
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.include(res.output, '"arguments":"{\\"status\\":\\"active\\"}"')
  })

  test('an authorizeTool filter reaches the handler as its row scope', async ({ assert }) => {
    const { controller, handlerCalls } = buildToolChat({
      tools: { authorizeTool: () => ({ kind: 'allow', filter: { userId: 'u1' } }) },
    })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.deepEqual(handlerCalls[0]!.filter, { userId: 'u1' })
  })

  test('a host with no tools configured keeps the plain single-round path', async ({ assert }) => {
    const { controller, provider, quota, handlerCalls } = buildToolChat({
      toolFree: true,
      rounds: [[{ data: 'hola', tokens: 2 }]],
    })
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.lengthOf(provider.calls, 1, 'no loop: exactly one provider round')
    assert.isUndefined(provider.calls[0]!.request.tools, 'a plain request carries no tools field')
    assert.lengthOf(handlerCalls, 0)
    assert.deepEqual(quota.reserves, [1024], 'the plain per-request reservation, not an aggregate')
    assert.notInclude(res.output, 'event: tool_call')
  })

  test('a registry of only action tools advertises nothing and stays plain chat', async ({
    assert,
  }) => {
    // Action tools are never advertised while the kill-switch is off,
    // so a registry holding only one leaves nothing to offer: the controller must fall
    // back to the plain closure rather than build a loop that can never call anything.
    const deleteBooking: AIToolHostDefinition = {
      name: 'delete_booking',
      description: 'Delete a booking.',
      inputSchema: { type: 'object', properties: {} },
      mode: 'action',
      handler: async () => ({ deleted: true }),
    }
    const { controller, provider, quota } = buildToolChat({
      tools: { registry: [deleteBooking] },
      rounds: [[{ data: 'hola', tokens: 2 }]],
    })
    const { ctx } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.lengthOf(provider.calls, 1)
    assert.isUndefined(provider.calls[0]!.request.tools)
    assert.deepEqual(quota.reserves, [1024], 'no advertised tool ⇒ no aggregate reservation')
  })

  test('an idempotent replay of a tool stream re-executes no tool', async ({ assert }) => {
    // The recorded bytes are replayed verbatim: a cached completed exchange must
    // never re-run a handler (an action tool would otherwise repeat its effect).
    const store = mapIdempotencyStore()
    const requestOptions = {
      tenant: fakeTenant,
      body: toolChatBody,
      headers: { 'idempotency-key': 'tool-retry-1' },
      auth: { user: { id: 'u1' } },
    }
    const { controller, provider, handlerCalls } = buildToolChat({ store })

    const first = fakeHttpContext(requestOptions)
    await controller.chat(first.ctx)
    assert.lengthOf(handlerCalls, 1)
    assert.lengthOf(provider.calls, 2)

    const second = fakeHttpContext(requestOptions)
    await controller.chat(second.ctx)

    assert.lengthOf(handlerCalls, 1, 'the replay must not re-execute the tool')
    assert.lengthOf(provider.calls, 2, 'the replay must not touch the provider')
    assert.equal(second.res.headers['x-ai-idempotent-replay'], '1')
    assert.equal(second.res.output, first.res.output, 'the replay is byte-identical')
  })
})

test.group('chat controller: confirmation flow', () => {
  /** A well-formed action tool: enabled, authorized (default hook), id-typed, summarizeable. */
  function cancelBooking(ran: { value: boolean }): AIToolHostDefinition {
    return {
      name: 'cancel_booking',
      description: 'Cancel a booking.',
      inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
      mode: 'action',
      summarizeArgs: (args) => `cancel ${String(args.id)}`,
      handler: async () => {
        ran.value = true
        return { cancelled: true }
      },
    }
  }

  test('an action the model proposes emits a tool_confirmation_required frame and runs nothing', async ({
    assert,
  }) => {
    const ran = { value: false }
    const { controller, provider } = buildToolChat({
      actionMachinery: true,
      tools: { registry: [cancelBooking(ran)], actionTools: { enabled: true } },
      rounds: [[toolCallFragment('call-1', 'cancel_booking', '{"id":"BK-1"}')]],
    })
    const { ctx, res } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
      auth: { user: { id: 'u1' } },
    })

    await controller.chat(ctx)

    // The challenge frame carries the HOST summary + a minted token; the effect never ran.
    assert.include(res.output, 'event: tool_confirmation_required')
    assert.include(res.output, '"summary":"cancel BK-1"')
    assert.include(res.output, '"token":"aitc1.')
    assert.include(res.output, '"name":"cancel_booking"')
    assert.isFalse(ran.value, 'the handler must not run until the human confirms')
    // The loop returned at the challenge: one provider round, a clean terminal done.
    assert.lengthOf(provider.calls, 1)
    assert.isTrue(res.output.endsWith('event: done\ndata: {"outcome":"completed"}\n\n'))
  })

  test('a confirming request is never served from the idempotency cache (the livelock fix)', async ({
    assert,
  }) => {
    // A plain chat caches under an Idempotency-Key; a retry that ALSO carries a
    // confirmation token must NOT be served that cache (else the same challenge frame
    // replays forever and the executor is never reached).
    const store = mapIdempotencyStore()
    const base = {
      tenant: fakeTenant,
      body: toolChatBody,
      auth: { user: { id: 'u1' } },
    }
    const { controller, provider } = buildToolChat({
      store,
      toolFree: true,
      rounds: [[{ data: 'hola', tokens: 2 }]],
    })

    const first = fakeHttpContext({ ...base, headers: { 'idempotency-key': 'k1' } })
    await controller.chat(first.ctx)
    const roundsAfterFirst = provider.calls.length

    const second = fakeHttpContext({
      ...base,
      headers: { 'idempotency-key': 'k1', 'x-ai-tool-confirmation': 'aitc1.jti.9999999999999.mac' },
    })
    await controller.chat(second.ctx)

    assert.notEqual(
      second.res.headers['x-ai-idempotent-replay'],
      '1',
      'a confirming request must not be cache-served'
    )
    assert.isAbove(provider.calls.length, roundsAfterFirst, 'it actually ran instead of replaying')
  })

  test('a confirming request is never written to the idempotency cache', async ({ assert }) => {
    // The symmetric half: a confirming request leaves nothing cached, so a later plain
    // retry of the same key finds no entry and runs rather than replaying.
    const store = mapIdempotencyStore()
    const base = {
      tenant: fakeTenant,
      body: toolChatBody,
      auth: { user: { id: 'u1' } },
    }
    const { controller, provider } = buildToolChat({
      store,
      toolFree: true,
      rounds: [[{ data: 'hola', tokens: 2 }]],
    })

    const confirming = fakeHttpContext({
      ...base,
      headers: { 'idempotency-key': 'k2', 'x-ai-tool-confirmation': 'aitc1.jti.9999999999999.mac' },
    })
    await controller.chat(confirming.ctx)
    const roundsAfterConfirming = provider.calls.length

    const plainRetry = fakeHttpContext({ ...base, headers: { 'idempotency-key': 'k2' } })
    await controller.chat(plainRetry.ctx)

    assert.notEqual(
      plainRetry.res.headers['x-ai-idempotent-replay'],
      '1',
      'the confirming request cached nothing, so the retry has nothing to replay'
    )
    assert.isAbove(provider.calls.length, roundsAfterConfirming, 'the retry ran')
  })
})

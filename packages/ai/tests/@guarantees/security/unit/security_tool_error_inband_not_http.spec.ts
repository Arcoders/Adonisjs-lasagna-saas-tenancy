import { test } from '@japa/runner'
import { fakeHttpContext } from '../../../helpers/fake_http_context.js'
import {
  buildToolChat,
  fakeTenant,
  toolCallFragment,
  toolChatBody,
} from '../../../helpers/tool_chat_doubles.js'

/**
 * The commit-point boundary for tool failures (WS-AI-11 / the spine's contract).
 * A tool loop streams, so by the time a tool is even called the SSE headers are
 * long flushed and an HTTP status is no longer available. Every mid-stream tool
 * refusal must therefore surface as an in-band `event: error` frame carrying ONLY
 * the classified code — never a status, never an upstream body, never a throw past
 * flushed headers — and the text already streamed must stand.
 *
 * The contrast matters as much: a refusal the controller can make BEFORE the first
 * byte (an unsupported provider, the concurrency cap) is still a real HTTP status
 * with headers unsent, so a client can act on it.
 */

/** A round that thinks out loud and then calls the tool. Repeats: the model never stops calling. */
const alwaysCalls = [
  [{ data: 'pensando', tokens: 1 }, toolCallFragment('call-1', 'count_bookings', '{}')],
]

test.group('security — a mid-stream tool failure is in-band, never an HTTP status', () => {
  test('exhausting the round budget ends in-band and the streamed text stands', async ({
    assert,
  }) => {
    const { controller, handlerCalls } = buildToolChat({
      tools: { maxRounds: 2 },
      rounds: alwaysCalls,
    })
    const { ctx, res, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
    })

    await controller.chat(ctx)

    assert.isTrue(res.flushed, 'the stream had already committed')
    assert.include(res.output, 'event: error\ndata: tool_budget_exhausted')
    assert.include(res.output, 'data: pensando', 'the text streamed before the ceiling stands')
    assert.isUndefined(responseFacade.sentStatus, 'no status past flushed headers')
    assert.isUndefined(responseFacade.sentBody)
    assert.isTrue(res.ended, 'the stream still closes cleanly')
    assert.lengthOf(handlerCalls, 1, 'round 1 ran the tool; the round-2 call was refused')
  })

  test('a hallucinated tool name aborts in-band with tool_unknown, not a 400', async ({
    assert,
  }) => {
    const { controller, handlerCalls } = buildToolChat({
      rounds: [
        [{ data: 'a ver', tokens: 1 }, toolCallFragment('call-9', 'drop_all_tables', '{}')],
        [{ data: 'nunca', tokens: 1 }],
      ],
    })
    const { ctx, res, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
    })

    await controller.chat(ctx)

    assert.include(res.output, 'event: error\ndata: tool_unknown')
    assert.isUndefined(responseFacade.sentStatus)
    assert.lengthOf(handlerCalls, 0, 'the unknown name never reached a handler')
    assert.notInclude(res.output, 'nunca', 'a fatal refusal aborts the loop, no further round')
  })

  test('a denied tool aborts in-band with tool_denied and never runs', async ({ assert }) => {
    const { controller, handlerCalls } = buildToolChat({
      tools: { authorizeTool: () => ({ kind: 'deny' }) },
    })
    const { ctx, res, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
    })

    await controller.chat(ctx)

    assert.include(res.output, 'event: error\ndata: tool_denied')
    assert.isUndefined(responseFacade.sentStatus)
    assert.lengthOf(handlerCalls, 0)
  })

  test('the error frame carries only the code, never the refusal message', async ({ assert }) => {
    const { controller } = buildToolChat({
      tools: {
        authorizeTool: () => {
          throw new Error('SELECT * FROM secrets failed at db://user:pw@host')
        },
      },
    })
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.include(res.output, 'event: error\ndata: tool_denied')
    assert.notInclude(res.output, 'SELECT')
    assert.notInclude(res.output, 'db://', 'an authz hook throw never leaks its internals')
  })

  test('a handler that throws degrades to a bounded result and the loop continues', async ({
    assert,
  }) => {
    // Resilience, not refusal: a tool that merely FAILED is not a security event.
    // The model gets a bounded error result to react to, and the stream completes.
    const { controller, provider } = buildToolChat({
      tools: {
        registry: [
          {
            name: 'count_bookings',
            description: 'Count bookings.',
            inputSchema: { type: 'object', properties: {} },
            mode: 'read',
            handler: async () => {
              throw new Error('connection refused at 10.0.0.5:5432')
            },
          },
        ],
      },
    })
    const { ctx, res } = fakeHttpContext({ tenant: fakeTenant, body: toolChatBody })

    await controller.chat(ctx)

    assert.notInclude(res.output, 'event: error', 'a failed tool is not a stream failure')
    assert.isTrue(res.output.endsWith('event: done\ndata: {"outcome":"completed"}\n\n'))
    const toolTurn = provider.calls[1]!.request.messages.at(-1)!
    assert.equal(toolTurn.content, '<tool_result>{"error":"tool_execution_failed"}</tool_result>')
    assert.notInclude(toolTurn.content, '10.0.0.5', 'the handler internals never reach the model')
  })
})

test.group('security — a pre-commit tool refusal keeps a real HTTP status', () => {
  test('a provider that does not support tools is refused 403 with headers unsent', async ({
    assert,
  }) => {
    // Fail CLOSED rather than advertise tools the provider silently drops and then
    // answer as if tool calling were simply unavailable.
    const { controller, provider } = buildToolChat({ providerDeclaresTools: false })
    const { ctx, res, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
    })

    await controller.chat(ctx)

    assert.equal(responseFacade.sentStatus, 403)
    assert.deepEqual(responseFacade.sentBody, { error: 'provider_not_allowed' })
    assert.isFalse(res.flushed, 'a pre-flight refusal must leave headers unsent')
    assert.lengthOf(provider.calls, 0, 'refused before any upstream call')
  })

  test('a resolveTools throw is a fail-closed pre-flight refusal, not a silent tool-free chat', async ({
    assert,
  }) => {
    const { controller, provider } = buildToolChat({
      tools: {
        registry: [],
        resolveTools: async () => {
          throw new Error('the tenant tool policy backend is down')
        },
      },
    })
    const { ctx, res, responseFacade } = fakeHttpContext({
      tenant: fakeTenant,
      body: toolChatBody,
    })

    await controller.chat(ctx)

    // A resolver that cannot decide must not be read as "this tenant gets no tools":
    // that would answer ungrounded as if tool calling were simply unavailable. It is
    // a pinned refusal, like every other host hook failing in the tool path.
    assert.equal(responseFacade.sentStatus, 403)
    assert.deepEqual(responseFacade.sentBody, { error: 'tool_denied' })
    assert.isFalse(res.flushed)
    assert.lengthOf(provider.calls, 0)
  })
})

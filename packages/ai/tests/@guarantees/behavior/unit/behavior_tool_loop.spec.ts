import { test } from '@japa/runner'
import { buildToolLoopProducer, type ToolLoopExecutor } from '../../../../src/gateway/tool_loop.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { AI_TOKENS_QUOTA } from '../../../../src/constants.js'
import {
  FakeQuota,
  FakeStreamTarget,
  fakeTenant,
  makeService,
} from '../../../helpers/stream_doubles.js'
import type {
  AIMessage,
  AIStreamRequest,
  AIToolCall,
  AIToolDefinition,
  StreamFragment,
} from '../../../../src/types/ai_provider_contract.js'

const TOOLS: AIToolDefinition[] = [
  { name: 'count_bookings', description: 'count the tenant bookings', inputSchema: {} },
]

function toolCall(id: string, name: string, args: string): StreamFragment {
  return { data: '', tokens: 0, event: 'tool_call', toolCall: { id, name, arguments: args } }
}

function usage(tokens: number): StreamFragment {
  return { data: '', tokens, event: 'usage' }
}

/** Records the calls it executed and returns a canned fenced result turn. */
class FakeExecutor implements ToolLoopExecutor {
  readonly calls: AIToolCall[] = []
  constructor(private readonly result = '{"ok":true}') {}
  async execute(call: AIToolCall): Promise<AIMessage> {
    this.calls.push(call)
    return { role: 'tool', content: this.result, toolCallId: call.id }
  }
}

const baseRequest: AIStreamRequest = {
  messages: [{ role: 'user', content: '¿cuántas reservas tengo?' }],
}

function runLoop(
  provider: MockAIProvider,
  executor: ToolLoopExecutor,
  opts: {
    worstCase?: number
    maxRounds?: number
    maxToolsPerRound?: number
    onBeforeRound?: (round: number) => Promise<void>
    log?: (message: string) => void
    surfaceToolArgs?: boolean
  } = {}
) {
  const { svc, quota } = makeService()
  const target = new FakeStreamTarget()
  const producer = buildToolLoopProducer({
    tenantId: 't1',
    provider,
    baseRequest,
    tools: TOOLS,
    executor,
    perRoundMaxTokens: 100,
    ...(opts.maxRounds !== undefined ? { maxRounds: opts.maxRounds } : {}),
    ...(opts.maxToolsPerRound !== undefined ? { maxToolsPerRound: opts.maxToolsPerRound } : {}),
    ...(opts.onBeforeRound ? { onBeforeRound: opts.onBeforeRound } : {}),
    ...(opts.log ? { log: opts.log } : {}),
    ...(opts.surfaceToolArgs !== undefined ? { surfaceToolArgs: opts.surfaceToolArgs } : {}),
  })
  return {
    target,
    quota,
    result: svc.stream(target, producer, {
      label: 'ai:chat',
      tenant: fakeTenant,
      quota: AI_TOKENS_QUOTA,
      worstCase: opts.worstCase ?? 1000,
      validateFragment: (f) => f,
    }),
  }
}

test.group('tool_loop (through the streaming spine)', () => {
  test('runs N rounds as one committed stream: notice + text, aggregated tokens, monotonic ids', async ({
    assert,
  }) => {
    const provider = new MockAIProvider({
      rounds: [
        [toolCall('c1', 'count_bookings', '{"status":"active"}'), usage(5)],
        [{ data: 'Tienes 4 reservas.', tokens: 0 }, usage(3)],
      ],
    })
    const executor = new FakeExecutor()
    const { target, result } = runLoop(provider, executor, { worstCase: 400 })
    const outcome = await result

    // One executor call, with the round-1 tool call.
    assert.lengthOf(executor.calls, 1)
    assert.equal(executor.calls[0]?.id, 'c1')
    // Provider re-entered once per round.
    assert.lengthOf(provider.calls, 2)

    // The client saw a redacted notice (name + id), NOT the arguments, then the answer.
    assert.include(target.output, '{"name":"count_bookings","id":"c1"}')
    assert.notInclude(target.output, 'status')
    assert.include(target.output, 'Tienes 4 reservas.')

    // One commit, aggregated tokens across both rounds, monotonic ids 1..4.
    assert.isTrue(target.flushed)
    assert.equal(outcome.outcome, 'completed')
    assert.equal(outcome.outcome === 'completed' ? outcome.tokensSettled : -1, 8)
    assert.include(target.output, 'id: 1\n')
    assert.include(target.output, 'id: 4\n')
    assert.notInclude(target.output, 'id: 5\n')
  })

  test('the model answering without a tool call ends in one round; the executor never runs', async ({
    assert,
  }) => {
    const provider = new MockAIProvider({ rounds: [[{ data: 'hola', tokens: 0 }, usage(2)]] })
    const executor = new FakeExecutor()
    const { result } = runLoop(provider, executor)
    const outcome = await result
    assert.lengthOf(executor.calls, 0)
    assert.lengthOf(provider.calls, 1)
    assert.equal(outcome.outcome, 'completed')
  })

  test('at maxRounds still calling tools: stops in-band with tool_budget_exhausted, text stands', async ({
    assert,
  }) => {
    // The single scripted round repeats, so the model "always" calls a tool.
    const provider = new MockAIProvider({ rounds: [[toolCall('c', 'count_bookings', '{}')]] })
    const executor = new FakeExecutor()
    const { target, result } = runLoop(provider, executor, { maxRounds: 2 })
    const outcome = await result

    // Round 1 executes; round 2 hits the ceiling and throws before executing.
    assert.lengthOf(executor.calls, 1)
    // The spine renders the throw as an in-band error frame, never an HTTP status.
    assert.include(target.output, 'event: error\ndata: tool_budget_exhausted')
    assert.equal(outcome.outcome, 'aborted')
    assert.equal(outcome.outcome === 'aborted' ? outcome.reason : '', 'provider_error')
  })

  test('a round over maxToolsPerRound executes the first N and logs the drop (no silent cap)', async ({
    assert,
  }) => {
    const provider = new MockAIProvider({
      rounds: [
        [
          toolCall('c1', 'count_bookings', '{}'),
          toolCall('c2', 'count_bookings', '{}'),
          toolCall('c3', 'count_bookings', '{}'),
        ],
        [{ data: 'listo', tokens: 0 }],
      ],
    })
    const executor = new FakeExecutor()
    const logs: string[] = []
    const { result } = runLoop(provider, executor, {
      maxToolsPerRound: 2,
      log: (m) => logs.push(m),
    })
    await result
    assert.deepEqual(
      executor.calls.map((c) => c.id),
      ['c1', 'c2']
    )
    assert.lengthOf(logs, 1)
    assert.match(logs[0] ?? '', /dropping/i)
  })

  test('rounds >= 2 consult the per-round rate limiter; a mid-loop denial ends in-band', async ({
    assert,
  }) => {
    const provider = new MockAIProvider({ rounds: [[toolCall('c', 'count_bookings', '{}')]] })
    const executor = new FakeExecutor()
    const seen: number[] = []
    const { target, result } = runLoop(provider, executor, {
      maxRounds: 4,
      onBeforeRound: async (round) => {
        seen.push(round)
        const { default: AIException } = await import('../../../../src/exceptions/ai_exception.js')
        throw new AIException('rate_limited', 'denied')
      },
    })
    const outcome = await result
    // Round 1 executed (no rate check); round 2 checked and was denied.
    assert.deepEqual(seen, [2])
    assert.lengthOf(executor.calls, 1)
    assert.include(target.output, 'event: error\ndata: rate_limited')
    assert.equal(outcome.outcome, 'aborted')
  })

  test('surfaceToolArgs includes the arguments in the client notice', async ({ assert }) => {
    const provider = new MockAIProvider({
      rounds: [
        [toolCall('c1', 'count_bookings', '{"status":"active"}')],
        [{ data: 'ok', tokens: 0 }],
      ],
    })
    const { target, result } = runLoop(provider, new FakeExecutor(), { surfaceToolArgs: true })
    await result
    assert.include(target.output, '"arguments":"{\\"status\\":\\"active\\"}"')
  })
})

import { test } from '@japa/runner'
import {
  buildToolLoopProducer,
  type ToolCallPlan,
  type ToolLoopExecutor,
} from '../../../../src/gateway/tool_loop.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import { AI_TOKENS_QUOTA } from '../../../../src/constants.js'
import {
  FakeQuota,
  FakeStreamTarget,
  fakeTenant,
  makeService,
} from '../../../helpers/stream_doubles.js'
import type {
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

/**
 * Every call plans to `run`; the run thunk records the call and returns a canned
 * fenced turn. Recording in the thunk (not in `plan`) means `calls` counts what
 * actually EXECUTED, so a challenged/aborted round leaves it untouched.
 */
class FakeExecutor implements ToolLoopExecutor {
  readonly calls: AIToolCall[] = []
  constructor(private readonly result = '{"ok":true}') {}
  async plan(call: AIToolCall): Promise<ToolCallPlan> {
    return {
      kind: 'run',
      run: async () => {
        this.calls.push(call)
        return { role: 'tool', content: this.result, toolCallId: call.id }
      },
    }
  }
}

/**
 * Plans each call per a decision fn ('run' | 'challenge' | 'throw'), recording which
 * calls actually RAN. Drives the planRound tests: a challenge mints a canned frame, a
 * throw is the FATAL a real gate raises during the scan.
 */
class ScriptedExecutor implements ToolLoopExecutor {
  readonly ran: string[] = []
  constructor(private readonly decide: (call: AIToolCall) => 'run' | 'challenge' | 'throw') {}
  async plan(call: AIToolCall): Promise<ToolCallPlan> {
    const choice = this.decide(call)
    if (choice === 'throw') {
      throw new AIException('tool_denied', 'Refusing the tool call: not authorized')
    }
    if (choice === 'challenge') {
      return {
        kind: 'challenge',
        challenge: {
          id: call.id,
          name: call.name,
          summary: `confirm ${call.name}`,
          token: `aitc1.${call.id}`,
          expiresAt: 9_999_999_999_999,
        },
      }
    }
    return {
      kind: 'run',
      run: async () => {
        this.ran.push(call.id)
        return { role: 'tool', content: '{}', toolCallId: call.id }
      },
    }
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

test.group('tool_loop: planRound (confirmation)', () => {
  test('an action awaiting confirmation emits a tool_confirmation_required frame and runs nothing', async ({
    assert,
  }) => {
    const provider = new MockAIProvider({
      rounds: [[toolCall('c1', 'cancel_booking', '{}')], [{ data: 'unreached', tokens: 0 }]],
    })
    const executor = new ScriptedExecutor((c) =>
      c.name === 'cancel_booking' ? 'challenge' : 'run'
    )
    const { target, result } = runLoop(provider, executor)
    const outcome = await result

    // The frame carries the host summary + minted token; nothing executed.
    assert.include(target.output, 'event: tool_confirmation_required')
    assert.include(target.output, '"token":"aitc1.c1"')
    assert.include(target.output, '"summary":"confirm cancel_booking"')
    assert.lengthOf(executor.ran, 0)
    // The loop returned at the challenge: the provider was never re-entered, and the
    // stream committed cleanly (a challenge is a turn boundary, not an error).
    assert.lengthOf(provider.calls, 1)
    assert.equal(outcome.outcome, 'completed')
  })

  test('a round mixing a runnable call and a challenge runs neither (no half-apply)', async ({
    assert,
  }) => {
    const provider = new MockAIProvider({
      rounds: [[toolCall('c1', 'read_weather', '{}'), toolCall('c2', 'cancel_booking', '{}')]],
    })
    const executor = new ScriptedExecutor((c) =>
      c.name === 'cancel_booking' ? 'challenge' : 'run'
    )
    const { target, result } = runLoop(provider, executor)
    await result

    // c1 planned to run but MUST NOT have: a round is never half-applied around a
    // pending confirmation, so the confirmed re-submit runs both together next turn.
    assert.lengthOf(executor.ran, 0)
    assert.include(target.output, 'event: tool_confirmation_required')
    assert.include(target.output, '"id":"c2"')
  })

  test('a fatal refusal during planning aborts the round before any earlier call runs', async ({
    assert,
  }) => {
    const provider = new MockAIProvider({
      rounds: [[toolCall('c1', 'read_weather', '{}'), toolCall('c2', 'forbidden', '{}')]],
    })
    const executor = new ScriptedExecutor((c) => (c.name === 'forbidden' ? 'throw' : 'run'))
    const { target, result } = runLoop(provider, executor)
    const outcome = await result

    // The scan threw on c2 before phase 2, so c1 never ran: a fatal in a round is
    // never half-applied either.
    assert.lengthOf(executor.ran, 0)
    assert.include(target.output, 'event: error\ndata: tool_denied')
    assert.equal(outcome.outcome, 'aborted')
  })
})

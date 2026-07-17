import { test } from '@japa/runner'
import db from '@adonisjs/lucid/services/db'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService from '../../../src/services/tool_executor.js'
import AIException from '../../../src/exceptions/ai_exception.js'
import { buildToolLoopProducer } from '../../../src/gateway/tool_loop.js'
import { parseAnthropicStream } from '../../../src/providers/wire/anthropic_sse.js'
import { parseOpenAiStream } from '../../../src/providers/wire/openai_sse.js'
import { byteSource, collect } from '../../helpers/sse_source.js'
import type { StreamProducer } from '../../../src/gateway/stream_extension.js'
import type {
  AIProviderName,
  AIToolHostDefinition,
  AIToolsConfig,
} from '../../../src/define_config.js'
import type { AIProviderContract, StreamFragment } from '../../../src/types/ai_provider_contract.js'

/**
 * Fault-injection tier: the provider connection dies MID `tool_use`, part-way
 * through the `input_json_delta` chunks that carry a tool call's arguments, so the
 * call is never terminated by its `stop_reason`.
 *
 * This is the fault that a unit spec with doubles cannot honestly reproduce. The
 * behaviour-tier specs hand the loop a ready-made `tool_call` fragment, which
 * assumes away the very thing at stake: whether a half-arrived call can become a
 * real one. So the whole chain is real here (the wire parser, the loop, the
 * executor, the tenant schema, the INSERT) and only the socket is faked, by a byte
 * source that stops in the middle of the argument JSON and then raises ECONNRESET.
 *
 * NO CORRUPT TOOL CALL, and note WHERE that guarantee actually lives, because it is
 * not the same in both dialects. A stream that dies with no terminal marker at all
 * emits nothing for the trivial reason that the finalize step never runs, so that
 * case pins no guard: it stays green even with both parsers' discard filters
 * deleted. The load-bearing case is a truncated block whose terminal stop DOES
 * arrive, and the two wires answer it differently:
 *
 *   - Anthropic keys the discard on `content_block_stop`, so a block that never
 *     closed is dropped at the finalize even when `stop_reason: 'tool_use'` lands.
 *     That filter is the only thing standing between a half-arrived block and the
 *     loop, so a sibling-block script pins it directly.
 *   - OpenAI keys its discard on id+name, NOT on completeness. A truncated call that
 *     already has both IS emitted, carrying unparseable argument JSON. Its defense is
 *     the next layer: `validateToolInput` refuses it FATALLY (`tool_input_invalid`)
 *     before the handler exists to be run.
 *
 * NO PARTIAL EFFECT: whichever layer refuses, the handler never runs, and the proof
 * is the tenant's own table still being empty rather than a spy boolean. RECOVERS: a
 * retry through the SAME executor completes normally and the row lands.
 *
 * The `runScoped` seam is a real `AsyncLocalStorage` rather than the kernel's
 * `tenancy.run`, which also connects the tenant and runs the bootstrapper lifecycle
 * and so needs provisioned tenants this harness does not have. ALS is what
 * `tenancy.run` is built on, and the property under test belongs to the satellite.
 * Every schema and connection name is derived from a per-run `suffix` and dropped by
 * name, so a chaos run never touches a schema it did not create (crypto's fault tier
 * once collided with the demo e2e suite on the shared local database).
 */

const suffix = randomUUID().replace(/-/g, '').slice(0, 12)

interface Realm {
  readonly tenant: TenantModelContract
  readonly schema: string
  readonly conn: string
}

/** The realm whose round is dropped and never retried: its table must stay empty forever. */
const DROPPED: Realm = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_drop_${suffix}`,
  conn: `ai_drop_conn_${suffix}`,
}
/** The realm that suffers the same drop and then retries: its table must hold exactly one row. */
const RECOVERED: Realm = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_recover_${suffix}`,
  conn: `ai_recover_conn_${suffix}`,
}
/** The realm whose round carries a truncated OpenAI call that the input gate must refuse. */
const PARTIAL: Realm = {
  tenant: { id: randomUUID() } as unknown as TenantModelContract,
  schema: `ai_partial_${suffix}`,
  conn: `ai_partial_conn_${suffix}`,
}
const REALMS = [DROPPED, RECOVERED, PARTIAL]

const TOOL_NAME = 'record_booking'
const TOOL_ID = 'toolu_drop_01'
const REFERENCE = 'BK-9'
/** The sibling call that DID close, so the Anthropic discard is proven selective, not blanket. */
const TOOL_ID_OK = 'toolu_ok_01'
const COMPLETE_REFERENCE = 'BK-OK'
const OPENAI_CALL_ID = 'call_drop_01'

let ready = false
let handlerRuns = 0

/** The ambient tenancy scope, the same shape `tenancy.run` / `tenancy.currentId` present. */
const als = new AsyncLocalStorage<string>()
const ctx = {} as unknown as HttpContext

/**
 * The tool whose effect we can see. It writes, which is what makes "no partial
 * effect" observable at all, but it is declared `mode: 'read'` because an `action`
 * tool is refused outright until the Phase 3a confirmation flow lands, and this spec
 * is about the transport fault rather than the action gate. It resolves its
 * connection from the AMBIENT scope, so it can only write to the right schema if the
 * executor really bound the scope around it.
 */
const recordBooking: AIToolHostDefinition = {
  name: TOOL_NAME,
  description: 'record a booking for this tenant',
  inputSchema: {
    type: 'object',
    properties: { reference: { type: 'string' } },
    required: ['reference'],
  },
  mode: 'read',
  handler: async (args) => {
    const active = als.getStore()
    if (!active) throw new Error('the handler ran with no ambient tenancy scope')
    const realm = REALMS.find((r) => r.tenant.id === active)
    if (!realm) throw new Error(`no realm for the active scope ${active}`)
    handlerRuns += 1
    await db
      .connection(realm.conn)
      .rawQuery(`INSERT INTO "${realm.schema}".tool_effects (reference) VALUES (?)`, [
        String(args.reference),
      ])
    return { recorded: args.reference }
  },
}

const toolsConfig: AIToolsConfig = {
  registry: [recordBooking],
  authorizeTool: () => ({ kind: 'allow' }),
}

/**
 * ONE executor for the whole group, deliberately: the recovery test proves the drop
 * left nothing wedged in the very instance that suffered it.
 */
const executor = new ToolExecutorService({
  runScoped: (tenant, fn) => als.run(tenant.id, fn),
  activeScopeTenantId: () => als.getStore(),
  getToolsConfig: () => toolsConfig,
})

const anthropicFrame = (event: string, payload: Record<string, unknown>): string =>
  `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`

const openAiFrame = (payload: Record<string, unknown>): string =>
  `data: ${JSON.stringify(payload)}\n\n`

/**
 * An Anthropic round that streams a line of text, opens a `tool_use` block, and gets
 * two chunks of its argument JSON out before the wire dies. There is no
 * `content_block_stop` and no `message_delta`, so the arguments are not even valid
 * JSON yet: `{"reference":"BK-9` with no closing quote or brace.
 */
const truncatedToolUse = (): string[] => [
  anthropicFrame('message_start', {
    type: 'message_start',
    message: { usage: { output_tokens: 1 } },
  }),
  anthropicFrame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'text' },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'voy a registrar la reserva' },
  }),
  anthropicFrame('content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: TOOL_ID, name: TOOL_NAME },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"reference":' },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: `"${REFERENCE}` },
  }),
]

/**
 * The case that actually pins the Anthropic discard. Two parallel `tool_use` blocks:
 * block 0 closes cleanly, block 1 is cut mid-argument and never gets its
 * `content_block_stop`, and THEN the terminal `stop_reason: 'tool_use'` arrives. So
 * the finalize step really runs with a half-arrived block in the map, and the
 * `complete` filter is the only thing keeping it out of the loop. Delete that filter
 * and this script yields a second call carrying unparseable JSON.
 */
const truncatedSiblingThenStop = (): string[] => [
  anthropicFrame('message_start', {
    type: 'message_start',
    message: { usage: { output_tokens: 1 } },
  }),
  anthropicFrame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: TOOL_ID_OK, name: TOOL_NAME },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: `{"reference":"${COMPLETE_REFERENCE}"}` },
  }),
  anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  anthropicFrame('content_block_start', {
    type: 'content_block_start',
    index: 1,
    content_block: { type: 'tool_use', id: TOOL_ID, name: TOOL_NAME },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: '{"reference":' },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 1,
    delta: { type: 'input_json_delta', partial_json: `"${REFERENCE}` },
  }),
  anthropicFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 12 },
  }),
  anthropicFrame('message_stop', { type: 'message_stop' }),
]

/**
 * The OpenAI counterpart: the same truncated arguments, but `finish_reason:
 * 'tool_calls'` arrives on the last frame. The accumulator already holds a valid id
 * and name, so this parser DOES emit the call, with `{"reference":"BK-9` as its
 * arguments. That is the parser's real behaviour; the refusal belongs to the input
 * gate, which is what the executor-level test asserts.
 */
const openAiTruncatedThenFinished = (): string[] => [
  openAiFrame({ choices: [{ delta: { content: 'voy a registrar la reserva' } }] }),
  openAiFrame({
    choices: [
      {
        delta: {
          tool_calls: [
            {
              index: 0,
              id: OPENAI_CALL_ID,
              function: { name: TOOL_NAME, arguments: '{"reference":' },
            },
          ],
        },
      },
    ],
  }),
  openAiFrame({
    choices: [
      {
        delta: { tool_calls: [{ index: 0, function: { arguments: `"${REFERENCE}` } }] },
        finish_reason: 'tool_calls',
      },
    ],
  }),
]

/** The same round, whole: the block closes and `message_delta` reports the terminal stop. */
const completeToolUse = (): string[] => [
  anthropicFrame('message_start', {
    type: 'message_start',
    message: { usage: { output_tokens: 1 } },
  }),
  anthropicFrame('content_block_start', {
    type: 'content_block_start',
    index: 0,
    content_block: { type: 'tool_use', id: TOOL_ID, name: TOOL_NAME },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: '{"reference":' },
  }),
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'input_json_delta', partial_json: `"${REFERENCE}"}` },
  }),
  anthropicFrame('content_block_stop', { type: 'content_block_stop', index: 0 }),
  anthropicFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'tool_use' },
    usage: { output_tokens: 12 },
  }),
  anthropicFrame('message_stop', { type: 'message_stop' }),
]

/** The second round of a healthy loop: plain text, no call, so the loop returns. */
const finalAnswer = (): string[] => [
  anthropicFrame('content_block_delta', {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: `reserva ${REFERENCE} registrada` },
  }),
  anthropicFrame('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 5 },
  }),
  anthropicFrame('message_stop', { type: 'message_stop' }),
]

const econnreset = (): Error => {
  const error = new Error('read ECONNRESET') as Error & { code?: string }
  error.code = 'ECONNRESET'
  return error
}

/** A byte source that delivers its chunks and then loses the socket, as a real drop does. */
function droppedSource(chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk)
    throw econnreset()
  })()
}

type WireParser = (source: AsyncIterable<Uint8Array>) => AsyncIterable<StreamFragment>

/**
 * A provider whose rounds are REAL byte scripts run through a REAL wire parser, so
 * what the loop consumes is whatever the shipped wire code makes of the bytes, never
 * a hand-written fragment. One script per `stream()` call; the last repeats once
 * exhausted, matching `MockAIProvider`'s rounds contract. The parser is injected
 * because the two dialects refuse a truncated call at different layers.
 */
class WireScriptedProvider implements AIProviderContract {
  readonly name: AIProviderName = 'claude'
  readonly contractVersion = 2
  readonly capabilities = { streaming: true, tools: true }
  #round = 0

  constructor(
    private readonly scripts: readonly (() => AsyncIterable<Uint8Array>)[],
    private readonly parse: WireParser = parseAnthropicStream
  ) {}

  async verifyConfig(): Promise<void> {}

  stream(): AsyncIterable<StreamFragment> {
    const script = this.scripts[Math.min(this.#round, this.scripts.length - 1)]
    this.#round += 1
    if (!script) throw new Error('the provider was scripted with no rounds')
    return this.parse(script())
  }
}

/** The provider that dies mid tool_use on its first (and only reached) round. */
const droppingProvider = (): AIProviderContract =>
  new WireScriptedProvider([() => droppedSource(truncatedToolUse())])

/** The provider that behaves: a complete tool_use round, then the answer. */
const healthyProvider = (): AIProviderContract =>
  new WireScriptedProvider([
    () => byteSource(...completeToolUse()),
    () => byteSource(...finalAnswer()),
  ])

function loopFor(realm: Realm, provider: AIProviderContract): StreamProducer {
  return buildToolLoopProducer({
    tenantId: realm.tenant.id,
    provider,
    baseRequest: { messages: [{ role: 'user', content: `registra la reserva ${REFERENCE}` }] },
    tools: [recordBooking],
    executor: executor.forRequest(ctx, realm.tenant, [recordBooking]),
    perRoundMaxTokens: 256,
  })
}

/** Pump a producer to exhaustion, keeping the fragments AND whatever killed it. */
async function drain(
  producer: StreamProducer
): Promise<{ fragments: StreamFragment[]; error: unknown }> {
  const fragments: StreamFragment[] = []
  try {
    for await (const fragment of producer(new AbortController().signal)) fragments.push(fragment)
  } catch (error) {
    return { fragments, error }
  }
  return { fragments, error: undefined }
}

const toolCalls = (fragments: StreamFragment[]): StreamFragment[] =>
  fragments.filter((f) => f.event === 'tool_call')

const text = (fragments: StreamFragment[]): string =>
  fragments
    .filter((f) => f.event === undefined || f.event === 'token')
    .map((f) => f.data)
    .join('')

async function effectRows(realm: Realm): Promise<string[]> {
  const result = await db
    .connection(realm.conn)
    .rawQuery(`SELECT reference FROM "${realm.schema}".tool_effects ORDER BY 1`)
  return (result.rows as { reference: string }[]).map((row) => row.reference)
}

test.group('provider drops mid tool_use (real Postgres)', (group) => {
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
        .rawQuery(`CREATE TABLE IF NOT EXISTS "${realm.schema}".tool_effects (reference text)`)
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
    handlerRuns = 0
  })

  test('a tool_use truncated mid input_json_delta yields no tool_call on either wire', async ({
    assert,
  }) => {
    // The weak half of the property, asserted for what it is: with no terminal marker
    // the finalize step never runs, so neither dialect can emit. This pins no discard
    // filter on its own (it passes with both deleted); the load-bearing case is the
    // sibling-block test below. It is still worth stating, because it is the shape a
    // real dropped socket takes.
    const anthropic = await collect(parseAnthropicStream(byteSource(...truncatedToolUse())))
    const openai = await collect(
      parseOpenAiStream(
        byteSource(
          openAiFrame({ choices: [{ delta: { content: 'voy a registrar la reserva' } }] }),
          openAiFrame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_drop_01',
                      function: { name: TOOL_NAME, arguments: '{"reference":' },
                    },
                  ],
                },
              },
            ],
          }),
          openAiFrame({
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: `"${REFERENCE}` } }] } },
            ],
          })
        )
      )
    )

    assert.lengthOf(toolCalls(anthropic), 0, 'a truncated Anthropic tool_use must be discarded')
    assert.lengthOf(toolCalls(openai), 0, 'a truncated OpenAI tool_call must be discarded')
    // The text that DID arrive still streams: the discard is scoped to the tool call.
    assert.include(text(anthropic), 'voy a registrar la reserva')
    assert.include(text(openai), 'voy a registrar la reserva')
    // And the half-formed arguments never leak into any fragment the client could see.
    assert.notInclude(JSON.stringify(anthropic), REFERENCE)
    assert.notInclude(JSON.stringify(openai), REFERENCE)

    // The control that keeps the assertions above from being vacuous: the same parser,
    // fed the same call WHOLE, does emit exactly one fully-formed tool_call. So the
    // zeroes above are a discard, not a parser that never emits anything.
    const whole = await collect(parseAnthropicStream(byteSource(...completeToolUse())))
    assert.lengthOf(toolCalls(whole), 1)
    assert.deepEqual(toolCalls(whole)[0]?.toolCall, {
      id: TOOL_ID,
      name: TOOL_NAME,
      arguments: `{"reference":"${REFERENCE}"}`,
    })
  }).skip(() => !ready, 'Postgres unavailable')

  test('an unclosed Anthropic block is discarded even when the terminal stop arrives', async ({
    assert,
  }) => {
    // THE mutant-killer for the Anthropic discard. The terminal stop lands with block
    // 1 still half-arrived, so `finalizeToolCalls` really runs over it and the
    // `complete` filter is the only thing keeping it out. Removing that filter makes
    // this yield a second call whose arguments are unparseable JSON.
    const fragments = await collect(parseAnthropicStream(byteSource(...truncatedSiblingThenStop())))
    const calls = toolCalls(fragments)

    // Selective, not blanket: the block that CLOSED still produces its call, so this
    // is a discard of the broken one rather than a parser that gave up on the round.
    assert.lengthOf(calls, 1, 'exactly the closed block survives the finalize')
    assert.deepEqual(calls[0]?.toolCall, {
      id: TOOL_ID_OK,
      name: TOOL_NAME,
      arguments: `{"reference":"${COMPLETE_REFERENCE}"}`,
    })
    // The half-arrived block leaks nothing: not its id, not its partial arguments.
    assert.notInclude(JSON.stringify(fragments), TOOL_ID)
    assert.notInclude(JSON.stringify(fragments), REFERENCE)
  }).skip(() => !ready, 'Postgres unavailable')

  test('a truncated OpenAI call survives the parser and the input gate refuses it fatally', async ({
    assert,
  }) => {
    // The honest OpenAI result, and the reason the wire-only assertion above is not
    // the whole guarantee. This parser discards on missing id/name, NOT on
    // completeness, so a call truncated mid-argument that already has both IS emitted
    // with unparseable JSON. First pin that at the wire, so the claim is on record.
    const wire = toolCalls(
      await collect(parseOpenAiStream(byteSource(...openAiTruncatedThenFinished())))
    )
    assert.lengthOf(wire, 1, 'the OpenAI parser emits a truncated call once finish_reason lands')
    assert.equal(wire[0]?.toolCall?.arguments, `{"reference":"${REFERENCE}`)

    // Then prove the layer that actually saves us: driven through the real loop and
    // the real executor, `validateToolInput` refuses the malformed arguments FATALLY
    // (per tool_executor's outer catch, a gate refusal throws rather than degrading),
    // so the handler never exists to be run and the tenant's table stays empty.
    const { fragments, error } = await drain(
      loopFor(
        PARTIAL,
        new WireScriptedProvider(
          [() => byteSource(...openAiTruncatedThenFinished())],
          parseOpenAiStream
        )
      )
    )

    assert.instanceOf(error, AIException)
    assert.equal((error as AIException).aiCode, 'tool_input_invalid')
    assert.equal(handlerRuns, 0, 'a call with unparseable arguments must never reach the handler')
    assert.deepEqual(await effectRows(PARTIAL), [], 'a refused call must leave no row behind')
    // The client notice carries name + id only, so the malformed arguments never
    // reach the client either.
    assert.notInclude(JSON.stringify(fragments), REFERENCE)
  }).skip(() => !ready, 'Postgres unavailable')

  test('a connection that dies mid tool_use executes nothing and writes no row', async ({
    assert,
  }) => {
    const { fragments, error } = await drain(loopFor(DROPPED, droppingProvider()))

    // The drop surfaces as the transport error it is, propagating out of the producer
    // for the spine to render in-band (the spine itself is not driven here). It is
    // emphatically NOT a tool call.
    assert.instanceOf(error, Error)
    assert.match((error as Error).message, /ECONNRESET/)
    assert.lengthOf(toolCalls(fragments), 0, 'a truncated call must never reach the loop')
    assert.include(text(fragments), 'voy a registrar la reserva', 'the text that arrived stands')

    // The proof that matters: not a spy, the table. The handler never ran, so the
    // tenant's schema is exactly as the drop found it.
    assert.equal(handlerRuns, 0, 'the handler must never run for a call that never completed')
    assert.deepEqual(
      await effectRows(DROPPED),
      [],
      'a tool call that never completed must leave no row behind'
    )
  }).skip(() => !ready, 'Postgres unavailable')

  test('the loop recovers on the next attempt and the tool runs exactly once', async ({
    assert,
  }) => {
    // Same realm, same executor, two attempts: the first drops mid tool_use, the
    // second is a clean stream. This is what a client retry after a dropped SSE
    // connection actually looks like.
    const dropped = await drain(loopFor(RECOVERED, droppingProvider()))
    assert.instanceOf(dropped.error, Error)
    assert.deepEqual(await effectRows(RECOVERED), [], 'the aborted attempt contributed nothing')

    const retry = await drain(loopFor(RECOVERED, healthyProvider()))

    assert.isUndefined(retry.error, 'the drop was transient; the retry must run clean')
    assert.lengthOf(toolCalls(retry.fragments), 1, 'the completed call reaches the loop')
    assert.include(text(retry.fragments), `reserva ${REFERENCE} registrada`)

    // Exactly one row, from the retry alone: the dropped attempt neither wrote nor
    // left a half-parsed call queued up to be replayed by the next round.
    assert.equal(handlerRuns, 1, 'the tool runs once across both attempts')
    assert.deepEqual(await effectRows(RECOVERED), [REFERENCE])
    // The retry wrote to ITS OWN realm and nowhere else. (An `als.getStore()` check
    // here would be vacuous: read outside any `als.run`, it is undefined by ALS's own
    // semantics no matter what the executor did, so it can never fail. The
    // cross-realm read is falsifiable: a mis-bound scope lands the row here.)
    assert.deepEqual(
      await effectRows(DROPPED),
      [],
      "the recovered realm's retry must not write into another realm's schema"
    )
  }).skip(() => !ready, 'Postgres unavailable')
})

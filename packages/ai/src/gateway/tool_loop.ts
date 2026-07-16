import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import type { StreamProducer, EmitMetric } from './stream_extension.js'
import type {
  AIMessage,
  AIProviderContract,
  AIStreamRequest,
  AIToolCall,
  AIToolDefinition,
  StreamFragment,
} from '../types/ai_provider_contract.js'
import {
  AI_TOOL_BUDGET_EXHAUSTED_METRIC,
  DEFAULT_AI_MAX_TOOL_ROUNDS,
  DEFAULT_MAX_TOOLS_PER_ROUND,
  MAX_AI_TOOL_ROUNDS,
  MAX_TOOLS_PER_ROUND,
  MAX_TOOL_CALLS_PER_REQUEST,
} from '../constants.js'

/**
 * Executes one model-issued tool call and returns the fenced, bounded
 * `role: 'tool'` result turn to re-inject on the next round. This is the loop's
 * seam onto Phase 3's tool executor (registry lookup, per-tool authorization,
 * argument validation, `tenancy.run` scoped execution, output fencing).
 *
 * Contract: a FATAL refusal (an unknown tool, a denied authorization, invalid
 * arguments, a scope breach) THROWS an {@link AIException}; the loop lets it
 * propagate so the spine emits the code as an in-band `event: error` frame and
 * ends the stream. A handler that merely fails (threw while running) does NOT
 * throw here: the executor returns a bounded error result turn so the model can
 * react and the loop continues. `signal` is the composed pump signal; the
 * executor composes the per-tool timeout on top of it. `round` (1-based) is passed
 * through for the executor's `op: 'tool'` audit row.
 */
export interface ToolLoopExecutor {
  execute(call: AIToolCall, signal: AbortSignal, round: number): Promise<AIMessage>
}

/** The per-round rate-limit hook (invariant 2). Called before rounds >= 2; a throw ends the loop in-band. */
export type OnBeforeRound = (round: number) => Promise<void>

/** Everything {@link buildToolLoopProducer} needs. Ceilings are resolved values; the loop clamps defensively. */
export interface ToolLoopDeps {
  /** The resolved request tenant id, for the `guard.ai_tool_budget_exhausted` trip. */
  readonly tenantId: string
  /** The provider whose `stream()` the loop re-enters each round. */
  readonly provider: AIProviderContract
  /**
   * The base request (assembled messages + model). The loop clones it per round,
   * appending the assistant tool-call turn and the fenced tool-result turns, and
   * overrides `maxTokens`/`tools`/`toolChoice`.
   */
  readonly baseRequest: AIStreamRequest
  /** The tools advertised to the model each round (from config, default-deny; Phase 5). */
  readonly tools: readonly AIToolDefinition[]
  /** The tool executor seam (Phase 3). */
  readonly executor: ToolLoopExecutor
  /** Per-round output-token cap: each round's `request.maxTokens`. The aggregate reservation is `this x maxRounds`. */
  readonly perRoundMaxTokens: number
  /** Per-round rate-limit hook (rounds >= 2). Optional; default no-op. */
  readonly onBeforeRound?: OnBeforeRound | undefined
  /** Max provider rounds. Default {@link DEFAULT_AI_MAX_TOOL_ROUNDS}, clamped to {@link MAX_AI_TOOL_ROUNDS}. */
  readonly maxRounds?: number | undefined
  /** Max tool calls executed per round. Default {@link DEFAULT_MAX_TOOLS_PER_ROUND}, clamped to {@link MAX_TOOLS_PER_ROUND}. */
  readonly maxToolsPerRound?: number | undefined
  /** Max total tool calls across the request. Default and hard cap {@link MAX_TOOL_CALLS_PER_REQUEST}. */
  readonly maxToolCallsPerRequest?: number | undefined
  /** Surface tool-call arguments in the client notice. Default false (name + id only). */
  readonly surfaceToolArgs?: boolean | undefined
  /** Structured drop/telemetry log (satisfied by the app logger). Optional; default no-op. */
  readonly log?: ((message: string) => void) | undefined
  /** Per-tenant integer metrics; used for `ai_tool_budget_exhausted`. Optional; default no-op. */
  readonly emitMetric?: EmitMetric | undefined
}

/**
 * Build the multi-round tool-loop {@link StreamProducer}. It lives INSIDE the
 * producer closure the chat controller hands the streaming spine, so there is
 * still exactly one pump: one reservation (`perRoundMaxTokens x maxRounds`,
 * passed to the spine by the caller), one `flushHeaders`, one `SseWriter`
 * stamping monotonic ids across every round, and one aggregated `StreamResult`.
 * The aggregate budget is enforced for free by the spine's `FragmentPipeline`
 * (each round's `usage` fragments accumulate toward the reservation worst case).
 *
 * Per round it re-enters `provider.stream()` with the accumulated turns: text and
 * usage fragments stream through live, `tool_call` fragments are intercepted (a
 * redacted notice is emitted in their place, arguments excluded by default). When
 * the model answers without a tool call the loop returns. When it calls tools and
 * rounds remain, the tools run through the injected executor and their fenced
 * `role: 'tool'` results are appended for the next round. At the round ceiling
 * still calling, the loop throws `tool_budget_exhausted`, which the spine renders
 * as an in-band error frame (the already-streamed text stands).
 *
 * When `tools` is empty the caller does not build this; a non-tool chat keeps the
 * plain `provider.stream` closure with zero overhead.
 */
export function buildToolLoopProducer(deps: ToolLoopDeps): StreamProducer {
  const maxRounds = resolveMaxRounds(deps.maxRounds)
  const maxToolsPerRound = resolveCeiling(
    deps.maxToolsPerRound,
    DEFAULT_MAX_TOOLS_PER_ROUND,
    MAX_TOOLS_PER_ROUND
  )
  const maxToolCallsPerRequest = resolveCeiling(
    deps.maxToolCallsPerRequest,
    MAX_TOOL_CALLS_PER_REQUEST,
    MAX_TOOL_CALLS_PER_REQUEST
  )

  return async function* toolLoop(signal: AbortSignal): AsyncIterable<StreamFragment> {
    const messages: AIMessage[] = [...deps.baseRequest.messages]
    let totalToolCalls = 0

    for (let round = 1; round <= maxRounds; round++) {
      if (signal.aborted) return

      // (1) Per-round rate limit (invariant 2): rounds >= 2 consult the limiter so
      //     the denial-of-wallet rail counts every upstream call. A denial throws
      //     an AIException that the spine renders in-band (headers already flushed).
      if (round >= 2 && deps.onBeforeRound) {
        await deps.onBeforeRound(round)
      }

      // (2) Pump this round. Text/usage stream through; tool_call fragments are
      //     intercepted and replaced by a redacted notice.
      const request: AIStreamRequest = {
        ...deps.baseRequest,
        messages,
        maxTokens: deps.perRoundMaxTokens,
        tools: deps.tools,
        toolChoice: deps.baseRequest.toolChoice ?? 'auto',
      }
      const calls: AIToolCall[] = []
      let assistantText = ''
      for await (const fragment of deps.provider.stream(request, signal)) {
        if (signal.aborted) return
        if (fragment.event === 'tool_call') {
          if (fragment.toolCall) {
            calls.push(fragment.toolCall)
            yield toolCallNotice(fragment.toolCall, deps.surfaceToolArgs)
          }
          continue
        }
        if (fragment.event === undefined || fragment.event === 'token') {
          assistantText += fragment.data
        }
        yield fragment
      }

      // (3) The model answered without calling a tool: the loop is done.
      if (calls.length === 0) return

      // (5) At the round ceiling but still calling: stop in-band, last text stands.
      if (round === maxRounds) {
        emitAiGuardEvent('guard.ai_tool_budget_exhausted', {
          tenantId: deps.tenantId,
          metadata: { reason: 'max_rounds' },
        })
        bumpBudgetMetric(deps)
        throw new AIException(
          'tool_budget_exhausted',
          'the tool loop reached its maximum number of rounds'
        )
      }

      // Enforce maxToolsPerRound: execute the first N and log the drop (no silent cap).
      let toExecute = calls
      if (calls.length > maxToolsPerRound) {
        deps.log?.(
          `ai tool loop: round ${round} requested ${calls.length} tools; ` +
            `executing the first ${maxToolsPerRound} and dropping the rest`
        )
        toExecute = calls.slice(0, maxToolsPerRound)
      }

      // (4) Append the assistant tool-call turn (its text, if any, plus exactly the
      //     calls we will answer), then execute each and append its fenced result.
      //     The assistant turn's calls MUST match the results we provide, or a
      //     re-injected turn is malformed (a tool_use with no tool_result).
      messages.push({ role: 'assistant', content: assistantText, toolCalls: toExecute })
      for (const call of toExecute) {
        if (signal.aborted) return
        totalToolCalls += 1
        if (totalToolCalls > maxToolCallsPerRequest) {
          emitAiGuardEvent('guard.ai_tool_budget_exhausted', {
            tenantId: deps.tenantId,
            metadata: { reason: 'max_calls' },
          })
          bumpBudgetMetric(deps)
          throw new AIException(
            'tool_budget_exhausted',
            'the request reached its maximum total number of tool calls'
          )
        }
        const resultTurn = await deps.executor.execute(call, signal, round)
        messages.push(resultTurn)
      }
      // Loop to round + 1 with the extended message history.
    }
  }
}

/**
 * A client-facing tool-call notice: `{ name, id }` only (arguments excluded
 * unless `surfaceToolArgs`), so the raw arguments never reach the client by
 * default. Carries `tokens: 0` (generation is metered by the `usage` fragment)
 * and rides the reserved `tool_call` event, and it passes the fragment gate like
 * any other client fragment.
 */
function toolCallNotice(call: AIToolCall, surfaceToolArgs: boolean | undefined): StreamFragment {
  const payload = surfaceToolArgs
    ? { name: call.name, id: call.id, arguments: call.arguments }
    : { name: call.name, id: call.id }
  return { data: JSON.stringify(payload), tokens: 0, event: 'tool_call' }
}

/** Resolve a ceiling: default when unset/malformed, clamped to the hard cap. */
function resolveCeiling(value: number | undefined, fallback: number, ceiling: number): number {
  const v = value ?? fallback
  if (!Number.isInteger(v) || v < 1) return Math.min(fallback, ceiling)
  return Math.min(v, ceiling)
}

/**
 * The effective max-rounds ceiling: the config value clamped to the hard cap.
 * Exported so the controller sizes the aggregate quota reservation
 * (`perRound × maxRounds`) with the EXACT clamp the loop enforces internally,
 * keeping the reservation and the loop's own round ceiling from ever drifting.
 */
export function resolveMaxRounds(value: number | undefined): number {
  return resolveCeiling(value, DEFAULT_AI_MAX_TOOL_ROUNDS, MAX_AI_TOOL_ROUNDS)
}

/** Best-effort `ai_tool_budget_exhausted` metric beside the guard trip; never breaks the throw. */
function bumpBudgetMetric(deps: ToolLoopDeps): void {
  try {
    deps.emitMetric?.(deps.tenantId, AI_TOOL_BUDGET_EXHAUSTED_METRIC, 1)
  } catch {
    /* metrics are best-effort */
  }
}

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
import { TOOL_CONFIRMATION_EVENT } from './sse_constants.js'

/**
 * A human-in-the-loop confirmation challenge for one proposed action call.
 * Everything the client needs to ask the human and, on
 * agreement, re-submit: the host-authored `summary`, the minted `token` (echoed
 * back in the `X-Ai-Tool-Confirmation` header), and its `expiresAt`. It carries no
 * tenant, principal, tool arguments, or model prose.
 */
export interface ToolConfirmationChallenge {
  /** The model's tool-call id, correlating this challenge with its `tool_call` notice. */
  readonly id: string
  /** The proposed tool's registered name (never its arguments). */
  readonly name: string
  /** The one line the host's `summarizeArgs` produced for the human to read. */
  readonly summary: string
  /** The opaque confirmation token to echo back in `X-Ai-Tool-Confirmation`. */
  readonly token: string
  /** Absolute expiry, ms since epoch. */
  readonly expiresAt: number
}

/**
 * The plan-phase outcome for one model-issued tool call.
 * `run` completes the call: the fenced, bounded `role: 'tool'` result turn to
 * re-inject next round, plus (for a confirmed action) the ledger claim and the
 * fail-closed intent audit. It runs NO effect until invoked, which is what lets
 * the loop scan a whole round before executing anything. `challenge` puts the
 * action to the human and runs nothing.
 *
 * A FATAL refusal (an unknown tool, a denied authorization, invalid arguments, a
 * scope breach, a presented-but-unmatched confirmation) is THROWN by `plan`, not
 * returned; the loop lets it propagate so the spine emits the code as an in-band
 * `event: error` frame and ends the stream. Because it throws DURING the scan,
 * before any `run` fires, a round is never half-applied around it.
 */
export type ToolCallPlan =
  | { readonly kind: 'run'; readonly run: () => Promise<AIMessage> }
  | { readonly kind: 'challenge'; readonly challenge: ToolConfirmationChallenge }

/**
 * The loop's seam onto the tool executor. `plan` classifies one call WITHOUT
 * running its effect (registry lookup, per-tool authorization, argument validation,
 * the confused-deputy re-assert, and the action confirmation decision), returning a
 * `run` thunk or a `challenge`. `signal` is the composed pump signal; the executor
 * composes the per-tool timeout on top of it inside `run`. `round` (1-based) is
 * carried through for the executor's `op: 'tool'` audit row. A handler that merely
 * fails (threw while running) does NOT surface as a throw: the `run` thunk resolves
 * to a bounded error result turn so the model can react and the loop continues.
 */
export interface ToolLoopExecutor {
  plan(call: AIToolCall, signal: AbortSignal, round: number): Promise<ToolCallPlan>
}

/** The per-round rate-limit hook. Called before rounds >= 2; a throw ends the loop in-band. */
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
  /** The tools advertised to the model each round (from config, default-deny). */
  readonly tools: readonly AIToolDefinition[]
  /** The tool executor seam. */
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

      // (1) Per-round rate limit: rounds >= 2 consult the limiter so
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

      // Enforce maxToolsPerRound: plan/run the first N and log the drop (no silent cap).
      let toExecute = calls
      if (calls.length > maxToolsPerRound) {
        deps.log?.(
          `ai tool loop: round ${round} requested ${calls.length} tools; ` +
            `executing the first ${maxToolsPerRound} and dropping the rest`
        )
        toExecute = calls.slice(0, maxToolsPerRound)
      }

      // (4) Plan the WHOLE round before running anything. Each `plan` classifies a
      //     call with no side effect; a fatal refusal throws HERE, during the scan,
      //     so a bad call aborts the round before an earlier good one has run. This
      //     is what stops a two-write round from applying the first write and only
      //     then stopping to challenge the second.
      const planned: ToolCallPlan[] = []
      for (const call of toExecute) {
        if (signal.aborted) return
        planned.push(await deps.executor.plan(call, signal, round))
      }

      // (4a) Any action awaiting a human? Emit each challenge as its own
      //      `tool_confirmation_required` frame and STOP: run nothing this round, so
      //      the round is never half-applied around a pending confirmation. The
      //      stream ends cleanly (the assistant text and tool-call notices stand) and
      //      the client re-submits once the human agrees, carrying the token(s).
      const challenges = planned.filter(isChallenge)
      if (challenges.length > 0) {
        for (const { challenge } of challenges) yield confirmationFrame(challenge)
        return
      }

      // (4b) No confirmation pending: append the assistant tool-call turn (its text,
      //      if any, plus exactly the calls we will answer), then run each and append
      //      its fenced result. The assistant turn's calls MUST match the results, or
      //      a re-injected turn is malformed (a tool_use with no tool_result).
      messages.push({ role: 'assistant', content: assistantText, toolCalls: toExecute })
      for (const plan of planned) {
        if (signal.aborted) return
        if (plan.kind !== 'run') continue // unreachable: challenges returned above
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
        messages.push(await plan.run())
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

/** Narrow a plan to the challenge arm (a typed `filter` predicate). */
function isChallenge(
  plan: ToolCallPlan
): plan is { kind: 'challenge'; challenge: ToolConfirmationChallenge } {
  return plan.kind === 'challenge'
}

/**
 * A `tool_confirmation_required` SSE frame carrying one challenge as JSON. It rides
 * its own reserved event (never {@link TOOL_CONFIRMATION_EVENT}'s default sibling),
 * so the loop's assistant-text accumulation and `reconstructAssistantText` both skip
 * it and the live token is never folded into persisted memory. `tokens: 0` because a
 * challenge is control, not generation. `JSON.stringify` escapes any newline in the
 * summary, so the frame stays a single `data:` line.
 */
function confirmationFrame(challenge: ToolConfirmationChallenge): StreamFragment {
  return { data: JSON.stringify(challenge), tokens: 0, event: TOOL_CONFIRMATION_EVENT }
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

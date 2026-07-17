import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AIToolHostDefinition, AIToolsConfig } from '../define_config.js'
import type { AIMessage, AIToolCall } from '../types/ai_provider_contract.js'
import type { ToolLoopExecutor } from '../gateway/tool_loop.js'
import type { EmitMetric } from '../gateway/stream_extension.js'
import { noopToolAuditSink, type AiToolAuditSink } from '../gateway/audit_seam.js'
import AIException from '../exceptions/ai_exception.js'
import {
  assertActionAllowed,
  assertActionConfirmed,
  assertActiveToolScope,
  assertClaimUsable,
  authorizeToolScope,
  resolveKnownTool,
} from '../gateway/tool_gate.js'
import { validateToolInput } from '../gateway/tool_input.js'
import { hashToolArgs } from '../gateway/tool_confirmation.js'
import type AiActionLedger from './action_ledger.js'
import {
  AI_TOOL_ACTION_EXECUTED_METRIC,
  AI_TOOL_ACTION_REPLAYED_METRIC,
  AI_TOOL_CALLS_METRIC,
  AI_TOOL_DENIALS_METRIC,
  AI_TOOL_ERRORS_METRIC,
  AI_TOOL_FENCE_TAG,
  AI_TOOL_LATENCY_METRIC,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_TIMEOUT_MS,
} from '../constants.js'

/**
 * The injected seams. `runScoped`/`activeScopeTenantId` are the same tenancy pair
 * the vector store and audit writer take (`tenancy.run` / `tenancy.currentId`),
 * so the executor unit-tests with fakes and the provider wires the real kernel.
 * `getToolsConfig` reads `config.ai.tools` at execution time (per-request bounds).
 * `toolAudit` and `emitMetric` are best-effort observability seams (default inert):
 * one `op: 'tool'` audit row and the per-outcome / latency metrics per call, never
 * on the reject path.
 */
export interface ToolExecutorDeps {
  runScoped: <T>(tenant: TenantModelContract, fn: () => Promise<T>) => Promise<T>
  activeScopeTenantId: () => string | undefined
  getToolsConfig: () => AIToolsConfig | undefined
  /** The `op: 'tool'` audit sink (WS-AI-11 / WS-AI-7). Absent ⇒ no audit row. */
  toolAudit?: AiToolAuditSink | undefined
  /** Per-tenant integer metrics (core's `MetricsService.emitMetric`). Absent ⇒ no metrics. */
  emitMetric?: EmitMetric | undefined
  /**
   * The confirmation MAC key (Phase 3a), derived from APP_KEY. ABSENT MEANS NO
   * ACTION TOOL CAN RUN: without it nothing can be verified, and an unverifiable
   * mutation must not happen. Read tools never consult it.
   */
  confirmationMacKey?: Buffer | undefined
  /**
   * The at-most-once fence (Phase 3a). Absent means no action tool can run, for the
   * same reason: an effect that cannot be fenced could fire twice.
   */
  actionLedger?: AiActionLedger | undefined
}

/**
 * Executes one model-issued tool call under the full WS-AI-11 security gate order
 * (Phase 3), fulfilling the loop's {@link ToolLoopExecutor} seam. Stateful only
 * through its injected seams, so it registers as a container singleton and is
 * `container.make`-resolved, never `new`-ed ad hoc.
 *
 * `forRequest` binds a request's `ctx`, `tenant` and the FULL resolved tool set
 * (read + action, so the gate can tell an unknown tool from a disabled action
 * one), returning the per-call executor the loop drives. Per call, in order:
 * resolve the tool (`tool_unknown`), refuse a disabled action (`tool_action_disabled`),
 * authorize (`tool_denied`), validate arguments (`tool_input_invalid`), re-assert the
 * ambient tenancy scope BEFORE binding (`tool_scope_mismatch`, the I7 confused-deputy
 * defense), then run the handler INSIDE `tenancy.run(tenant)` under a per-tool timeout
 * that actually unblocks the loop, and fence the result as an untrusted `role: 'tool'`
 * turn. A FATAL refusal — any of the four gate throws, or the I7 scope breach — throws
 * (the loop renders it in-band and aborts); a handler that merely fails (threw, even a
 * nested AIException, or timed out) degrades to a bounded error result so the model can
 * react and the loop continues.
 */
export default class ToolExecutorService {
  constructor(private readonly deps: ToolExecutorDeps) {}

  /**
   * Bind a request. `confirmations` are the tokens the client presented on THIS
   * request (Phase 3a); an empty list is the normal read-only case and also the
   * first turn of an action, before the human has agreed to anything.
   */
  forRequest(
    ctx: HttpContext,
    tenant: TenantModelContract,
    fullSet: readonly AIToolHostDefinition[],
    principalHash?: string | null,
    confirmations: readonly string[] = []
  ): ToolLoopExecutor {
    return {
      execute: (call, signal, round) =>
        this.#executeOne(
          ctx,
          tenant,
          fullSet,
          call,
          signal,
          round,
          principalHash ?? null,
          confirmations
        ),
    }
  }

  async #executeOne(
    ctx: HttpContext,
    tenant: TenantModelContract,
    fullSet: readonly AIToolHostDefinition[],
    call: AIToolCall,
    signal: AbortSignal,
    round: number,
    principalHash: string | null,
    confirmations: readonly string[]
  ): Promise<AIMessage> {
    const toolsConfig = this.deps.getToolsConfig()
    const maxResultChars = clamp(
      toolsConfig?.maxToolResultChars,
      DEFAULT_MAX_TOOL_RESULT_CHARS,
      MAX_TOOL_RESULT_CHARS
    )
    const startedAt = Date.now()
    this.#metric(tenant.id, AI_TOOL_CALLS_METRIC, 1)

    // `tool` is captured for the catch (its `mode` labels the audit row): undefined
    // until the tool resolves, so a `tool_unknown` denial audits mode 'read'.
    let tool: AIToolHostDefinition | undefined
    try {
      // Gate order — each throws its own AIException (+ Isthmus guard) on refusal.
      const t = resolveKnownTool(fullSet, call.name, tenant.id)
      tool = t
      assertActionAllowed(t, tenant.id, toolsConfig)
      const scope = await authorizeToolScope(ctx, tenant, t, toolsConfig)
      const args = validateToolInput(call.arguments, t, {
        ...(toolsConfig?.maxToolArgsChars !== undefined
          ? { maxArgsChars: toolsConfig.maxToolArgsChars }
          : {}),
        tenantId: tenant.id,
      })

      // The I7 / confused-deputy re-assertion, BEFORE `runScoped` binds the scope
      // (mirrors `ai_audit_writer.append` and `vector_store #target`): reading the
      // active scope here reflects the caller's AMBIENT scope, so if the request is
      // already running inside a tenancy scope it must be this tenant's. Reading it
      // inside the bind instead would compare the just-set scope to itself — a
      // tautology. It stays in THIS try so a breach is audited (outcome 'error'),
      // then rethrown as a FATAL abort. An undefined ambient scope (the normal
      // streaming path, none bound) trusts the caller, like the two mirrored seams;
      // the kernel ContextSeal remains the per-query backstop.
      assertActiveToolScope(this.deps.activeScopeTenantId(), tenant.id)

      // An action tool needs a human to have agreed to THIS call, and the effect
      // needs to be fenced, before anything runs. Both throw on refusal, so a write
      // that gets past here is one somebody confirmed and nobody has run yet.
      // Returns the claimed fence, or null for a read tool.
      const claim = await this.#authorizeAction(
        t,
        tenant,
        args,
        principalHash,
        confirmations,
        round
      )

      const timeoutMs = clamp(
        toolsConfig?.toolTimeoutMs,
        DEFAULT_TOOL_TIMEOUT_MS,
        MAX_TOOL_TIMEOUT_MS
      )

      // The handler runs in its OWN try so a failure degrades (never reaches the
      // outer catch, which is exclusively for the fatal gate refusals above).
      let failed = false
      let result: unknown
      try {
        result = await this.deps.runScoped(tenant, async () => {
          const timed = composeToolSignal(signal, timeoutMs)
          try {
            // Race the handler against the composed signal so a handler that IGNORES
            // its AbortSignal cannot hang the single pump past `toolTimeoutMs` (or a
            // client disconnect / liveness revoke): on abort the race rejects, the
            // call degrades, and the pump / reservation / per-tenant concurrency slot
            // are freed even though the handler keeps running detached.
            return await runWithAbort(
              () =>
                t.handler(args, {
                  tenant,
                  ctx,
                  signal: timed.signal,
                  ...(scope.kind === 'allow' && scope.filter ? { filter: scope.filter } : {}),
                  // Only a confirmed action carries one. The satellite already fences
                  // the effect; this is for a handler whose own downstream wants an
                  // idempotency key of its own.
                  ...(claim ? { idempotencyKey: claim.effectKey } : {}),
                }),
              timed.signal
            )
          } finally {
            timed.dispose()
          }
        })
      } catch {
        // A handler that threw, timed out, or was aborted (including a nested
        // AIException a host handler may raise, e.g. a read-tool calling the
        // satellite's own retrieval on a transient error): degrade to a bounded
        // error result the model can react to; the loop continues (resilience).
        failed = true
      }

      if (failed) this.#metric(tenant.id, AI_TOOL_ERRORS_METRIC, 1)
      this.#metric(tenant.id, AI_TOOL_LATENCY_METRIC, Date.now() - startedAt)

      const resultTurn = failed
        ? buildToolResultTurn(call.id, { error: 'tool_execution_failed' }, maxResultChars)
        : buildToolResultTurn(call.id, result, maxResultChars)

      // Close the fence for an action. The recorded result is the bounded, fenced
      // turn, so a replay hands back exactly what the first attempt produced rather
      // than re-deriving it. `settle` is fail-closed and `fail` is best-effort: see
      // the ledger for why the two differ.
      if (claim) {
        if (failed)
          await this.deps.actionLedger?.fail(tenant.id, claim.effectKey, 'tool_execution_failed')
        else await this.deps.actionLedger?.settle(tenant.id, claim.effectKey, resultTurn.content)
      }

      await this.#auditToolSafe(tenant.id, principalHash, call.name, t.mode ?? 'read', round, {
        outcome: failed ? 'failed' : 'completed',
        reason: failed ? 'tool_execution_failed' : null,
      })
      return resultTurn
    } catch (error) {
      // A FATAL gate refusal (unknown / action-disabled / denied / invalid) or the
      // I7 scope breach: meter the denial, audit it, and rethrow so the loop renders
      // it in-band and aborts. A scope breach is the one 'error' outcome; the rest
      // are 'denied'. The precise code rides in `reason`.
      this.#metric(tenant.id, AI_TOOL_DENIALS_METRIC, 1)
      const code = error instanceof AIException ? error.aiCode : 'error'
      await this.#auditToolSafe(tenant.id, principalHash, call.name, tool?.mode ?? 'read', round, {
        outcome: code === 'tenant_scope_mismatch' ? 'error' : 'denied',
        reason: code,
      })
      throw error
    }
  }

  /**
   * The action-tool path (Phase 3a). Returns null for a read tool, which is the
   * whole of the read story: none of this runs.
   *
   * For an action tool, in this order, each step refusing rather than degrading:
   *
   * 1. The infrastructure must exist. No MAC key or no ledger means the effect
   *    cannot be verified or fenced, so it must not happen.
   * 2. The principal must resolve. A confirmation binds to a person; bound to
   *    nobody, the token would be spendable by any session holding the string.
   * 3. A presented token must authorize THIS call. `verifyToolConfirmation`
   *    re-derives the binding from the request, so a token for another tenant, user,
   *    tool or arguments simply is not this value. No token at all is NOT an error:
   *    it is the first turn, and the loop challenges the human. A token that was
   *    presented and did not match IS an error, because the client believed it had
   *    permission and did not.
   * 4. Claim the fence BEFORE running. A `replay` means this exact token already
   *    fired: never run it again.
   * 5. Write the audit intent FAIL-CLOSED, before the effect. This is the one place
   *    the audit ordering inverts. A read tool audits best-effort afterwards because
   *    losing the record of a read costs a log line. An action that mutated without
   *    a durable record of intent is a mutation nobody can account for, so if the
   *    intent cannot be written the action does not happen.
   */
  async #authorizeAction(
    tool: AIToolHostDefinition,
    tenant: TenantModelContract,
    args: Record<string, unknown>,
    principalHash: string | null,
    confirmations: readonly string[],
    round: number
  ): Promise<{ effectKey: string } | null> {
    if (tool.mode !== 'action') return null

    // Every decision below lives in tool_gate beside the other gates. This method
    // owns the ORDERING and the side effects; it decides nothing itself, which is
    // why it throws nothing itself.
    const ledger = this.deps.actionLedger
    const binding = principalHash
      ? {
          tenantId: tenant.id,
          principalHash,
          toolName: tool.name,
          argsHash: hashToolArgs(args),
        }
      : null
    const confirmed = assertActionConfirmed(
      tool,
      tenant.id,
      binding,
      confirmations,
      this.deps.confirmationMacKey,
      ledger !== undefined
    )

    // `assertActionConfirmed` refuses when `ledgerReady` is false, so reaching here
    // means the ledger is present. The compiler cannot follow that through a boolean
    // argument, and re-testing it would add a second unreachable refusal path for
    // the same fact.
    const claim = await ledger!.claim(tenant.id, confirmed.effectKey, tool.name)
    if (claim.kind === 'replay') this.#metric(tenant.id, AI_TOOL_ACTION_REPLAYED_METRIC, 1)
    assertClaimUsable(claim, tenant.id, tool.name)

    // Fail-closed intent, BEFORE the effect. A throw here aborts the call, which is
    // the point: the fence is already claimed, so the action cannot silently run
    // unrecorded, and the claimed row reads as "unknown" rather than "safe".
    await (this.deps.toolAudit ?? noopToolAuditSink).append({
      tenantId: tenant.id,
      principalHash,
      toolName: tool.name,
      mode: 'action',
      outcome: 'intent',
      // The shared row has three outcomes, so an intent lands as 'aborted' (true at
      // the moment it is written: the effect has not happened). The reason is what
      // tells it apart from a real abort when reading the chain back.
      reason: 'action_intent',
      round,
      tokens: 0,
      occurredAt: new Date().toISOString(),
    })

    this.#metric(tenant.id, AI_TOOL_ACTION_EXECUTED_METRIC, 1)
    return { effectKey: confirmed.effectKey }
  }

  /** Best-effort per-tenant metric: a failing sink can never touch the tool call. */
  #metric(tenantId: string, name: string, value: number): void {
    try {
      this.deps.emitMetric?.(tenantId, name, value)
    } catch {
      /* metrics are best-effort */
    }
  }

  /**
   * Write one `op: 'tool'` audit row, best-effort (like the chat `#auditSafe`): a
   * read-tool audit failure must not fail the loop. The event carries only non-PII
   * fields (never the arguments or the result). NOTE (Phase 3a): an action tool's
   * intent must instead be written FAIL-CLOSED before the effect; that path lands
   * with the action-tool confirmation flow.
   */
  async #auditToolSafe(
    tenantId: string,
    principalHash: string | null,
    toolName: string,
    mode: 'read' | 'action',
    round: number,
    result: { outcome: 'completed' | 'denied' | 'failed' | 'error'; reason: string | null }
  ): Promise<void> {
    try {
      await (this.deps.toolAudit ?? noopToolAuditSink).append({
        tenantId,
        principalHash,
        toolName,
        mode,
        outcome: result.outcome,
        reason: result.reason,
        round,
        tokens: 0,
        occurredAt: new Date().toISOString(),
      })
    } catch {
      /* best-effort: a guard.ai_audit_write_failed already tripped in the writer */
    }
  }
}

/**
 * Fence a handler's return as an untrusted `role: 'tool'` result turn (WS-AI-11).
 * The result is coerced to a string (`undefined`/`null` -> empty, non-string ->
 * JSON, non-serializable -> a safe placeholder), bounded to `maxChars`, and any
 * occurrence of the fence token inside it is neutralized so it cannot forge a
 * closing tag and "break out" of its block, exactly like the retrieved-context
 * fence. Role separation (a `tool` turn, never a trusted instruction turn) is the
 * real defense; the fence is defense-in-depth. Pure, so it unit-tests alone.
 */
export function buildToolResultTurn(
  toolCallId: string,
  result: unknown,
  maxChars: number
): AIMessage {
  const serialized = serializeToolResult(result)
  const open = `<${AI_TOOL_FENCE_TAG}>`
  const close = `</${AI_TOOL_FENCE_TAG}>`
  const budget = Math.max(0, maxChars - open.length - close.length)
  // Neutralize is length-preserving (same-length replacement), so bound first.
  const bounded = serialized.length > budget ? serialized.slice(0, budget) : serialized
  const body = neutralizeToolFence(bounded)
  return { role: 'tool', content: `${open}${body}${close}`, toolCallId }
}

function serializeToolResult(result: unknown): string {
  if (result === undefined || result === null) return ''
  if (typeof result === 'string') return result
  try {
    return JSON.stringify(result) ?? ''
  } catch {
    // Circular / BigInt / other non-JSON value: a bounded, safe placeholder.
    return '"tool result was not serializable"'
  }
}

/** Neutralize the fence token inside a tool result (case-insensitive, length-preserving). */
function neutralizeToolFence(text: string): string {
  return text.replace(new RegExp(AI_TOOL_FENCE_TAG, 'gi'), 'tool-result')
}

/**
 * Await `work()` but stop waiting the instant `signal` aborts (the per-tool
 * timeout, a client disconnect, or a liveness revoke). An `AbortSignal` is
 * cooperative — a handler that never inspects it would otherwise block the single
 * pump indefinitely — so this races the handler promise against the abort and
 * rejects on abort (the caller degrades the call). The handler may keep running
 * detached; its late settlement is consumed here so it never surfaces as an
 * unhandled rejection. An already-aborted signal rejects before `work` even starts.
 */
function runWithAbort<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('tool handler aborted before it started'))
      return
    }
    const onAbort = (): void => reject(new Error('tool handler aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          signal.removeEventListener('abort', onAbort)
          resolve(value)
        },
        (error) => {
          signal.removeEventListener('abort', onAbort)
          reject(error)
        }
      )
  })
}

/**
 * Compose the request signal with a per-tool timeout into one child signal. It
 * aborts when the parent aborts (disconnect / deadline / budget) OR after
 * `timeoutMs`. `dispose` clears the timer and detaches the listener so a completed
 * tool leaves nothing pending.
 */
function composeToolSignal(
  parent: AbortSignal,
  timeoutMs: number
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  if (parent.aborted) {
    controller.abort()
    return { signal: controller.signal, dispose: () => {} }
  }
  const onAbort = (): void => controller.abort()
  parent.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (typeof timer.unref === 'function') timer.unref()
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
    },
  }
}

function clamp(value: number | undefined, fallback: number, ceiling: number): number {
  const v = value ?? fallback
  if (!Number.isInteger(v) || v < 1) return Math.min(fallback, ceiling)
  return Math.min(v, ceiling)
}

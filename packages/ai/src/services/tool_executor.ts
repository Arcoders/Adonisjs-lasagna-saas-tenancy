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
  assertActiveToolScope,
  authorizeToolScope,
  resolveKnownTool,
} from '../gateway/tool_gate.js'
import { validateToolInput } from '../gateway/tool_input.js'
import {
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

  forRequest(
    ctx: HttpContext,
    tenant: TenantModelContract,
    fullSet: readonly AIToolHostDefinition[],
    principalHash?: string | null
  ): ToolLoopExecutor {
    return {
      execute: (call, signal, round) =>
        this.#executeOne(ctx, tenant, fullSet, call, signal, round, principalHash ?? null),
    }
  }

  async #executeOne(
    ctx: HttpContext,
    tenant: TenantModelContract,
    fullSet: readonly AIToolHostDefinition[],
    call: AIToolCall,
    signal: AbortSignal,
    round: number,
    principalHash: string | null
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
      assertActionAllowed(t, tenant.id)
      const scope = await authorizeToolScope(ctx, tenant, t.name, toolsConfig)
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
      await this.#auditToolSafe(tenant.id, principalHash, call.name, t.mode ?? 'read', round, {
        outcome: failed ? 'failed' : 'completed',
        reason: failed ? 'tool_execution_failed' : null,
      })
      return failed
        ? buildToolResultTurn(call.id, { error: 'tool_execution_failed' }, maxResultChars)
        : buildToolResultTurn(call.id, result, maxResultChars)
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

import type { HttpContext } from '@adonisjs/core/http'
// QuotaReservation is a type-only import: importing a VALUE from the core
// `/services` barrel eagerly loads `@adonisjs/redis` (top-level `app.booted`),
// which throws in a bare unit runner. The runtime seams (executeExtension, the
// timeout-error test) are injected instead, so this module stays unit-loadable.
import type { QuotaReservation } from '@adonisjs-lasagna/saas-tenancy/services'
import { composeSignals, onRequestDisconnect } from '@adonisjs-lasagna/saas-tenancy/signals'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import SseWriter, { type SseSink } from './sse_writer.js'
import FragmentPipeline from './fragment_pipeline.js'
import { DEFAULT_HEARTBEAT_MS } from '../constants.js'
import AIException, { type AIErrorCode } from '../exceptions/ai_exception.js'
import type { StreamFragment } from '../types/ai_provider_contract.js'

/** Produces the model's fragments; threads the composed abort into its transport. */
export type StreamProducer = (signal: AbortSignal) => AsyncIterable<StreamFragment>

/**
 * The inbound sink the service pumps to, abstracted so the service unit-tests
 * without an HttpContext. {@link httpStreamTarget} adapts a real request; a test
 * supplies a fake sink and a controllable disconnect signal.
 */
export interface StreamTarget {
  readonly sink: SseSink
  flushHeaders(): void
  disconnect(): { signal: AbortSignal; dispose: () => void }
}

/** The quota reservation seam (structurally satisfied by core's QuotaService). */
export interface StreamQuota {
  reserve(tenant: TenantModelContract, quota: string, worstCase: number): Promise<QuotaReservation>
  settle(reservation: QuotaReservation, cumulativeUsed: number): Promise<void>
  release(reservation: QuotaReservation): Promise<number>
}

/** The breaker pre-flight seam (structurally satisfied by core's CircuitBreakerService). */
export interface StreamBreaker {
  run(tenantId: string): Promise<void>
}

/** Options bag for the injected extension runner (a subset of core's ExecuteExtensionOptions). */
export interface RunExtensionOptions {
  label: string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * The injected extension runner, satisfied by core's `executeExtension`. Injected
 * rather than imported so this module never pulls the core `/services` barrel
 * (which eagerly loads redis) into the bare unit runner.
 */
export type RunExtension = <T>(
  fn: (signal: AbortSignal) => Promise<T>,
  options: RunExtensionOptions
) => Promise<T>

/** Records a per-tenant integer metric (satisfied by core's MetricsService.emitMetric). */
export type EmitMetric = (tenantId: string, name: string, value: number) => void | Promise<void>

/** Runs a callback inside a named span (satisfied by core's TelemetryService.withSpan). */
export type WithSpan = <T>(
  name: string,
  attrs: Record<string, string | number | boolean>,
  fn: () => Promise<T>
) => Promise<T>

export interface StreamExtensionServiceDeps {
  quota: StreamQuota
  breaker?: StreamBreaker
  /** Core's `executeExtension`. */
  runExtension: RunExtension
  /** Recognizes core's `ExtensionTimeoutError`. Defaults to never (a caught error is a provider error). */
  isTimeoutError?: (error: unknown) => boolean
  /** Integer usage metrics. Defaults to a no-op. Best-effort: a failure is swallowed. */
  emitMetric?: EmitMetric
  /** Span wrapper. Defaults to a passthrough. */
  withSpan?: WithSpan
}

export interface StreamExtensionOptions {
  /** Names the extension for the timeout error and telemetry. */
  label: string
  /** The tenant, handed to `reserve` (which spans by tenant id). */
  tenant: TenantModelContract
  /** The quota name to reserve against. */
  quota: string
  /** The per-request output cap = the reservation worst case (from request.maxTokens, config-bounded). */
  worstCase: number
  /** Response deadline in ms. The composed abort fires at the deadline (executeExtension's timer). */
  timeoutMs?: number | undefined
  /** The output-bound fragment guard; returning null aborts without writing the leaking bytes. */
  validateFragment: (fragment: StreamFragment) => StreamFragment | null
  /** G11: aborts the stream when the tenant is suspended or deleted mid-flight. */
  livenessSignal?: AbortSignal | undefined
  /** SSE heartbeat interval. Default {@link DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number | undefined
  /** Resume cursor from the client's Last-Event-ID. */
  lastEventId?: string | undefined
  /** Provider name, for the span attribute only (never content). */
  provider?: string | undefined
  /** Model name, for the span attribute only (never content). */
  model?: string | undefined
}

/** Why a stream stopped after it committed (headers flushed). */
export type StreamAbortReason =
  | 'budget'
  | 'timeout'
  | 'tenant_suspended'
  | 'client_disconnect'
  | 'fragment_rejected'
  | 'provider_error'

/**
 * Why a stream never committed (resolved before headers, so a caller can set a
 * status). It is the AI error-code space: the pinned HTTP status and
 * retryability come from the exception's single-source-of-truth tables
 * (`httpStatusForAiCode` / `RETRYABILITY`), so a fatal typed refusal thrown
 * pre-commit (provider_not_allowed 403, byok_endpoint_blocked 400) keeps its own
 * status instead of collapsing to a retryable 503. The spine only ever produces
 * the pre-flight-reachable subset (over_budget, rate_limited,
 * rate_limit_unavailable, provider_unavailable, plus any AIException the
 * producer raises before the first byte); typing it as the full code space keeps
 * the status mapping from drifting into a second hand-maintained table.
 */
export type StreamPreflightError = AIErrorCode

export type StreamResult =
  | {
      outcome: 'completed'
      tokensSettled: number
      fragments: number
      lastEventId: string | undefined
    }
  | {
      outcome: 'aborted'
      reason: StreamAbortReason
      tokensSettled: number
      fragments: number
      lastEventId: string | undefined
    }
  | { outcome: 'failed_preflight'; error: StreamPreflightError }

/**
 * Adapt a real request into a {@link StreamTarget}: the SSE sink is the Node
 * `ServerResponse`, `flushHeaders` sets the event-stream headers and flushes,
 * and disconnect wiring goes through the core `onRequestDisconnect` seam (the
 * only sanctioned toucher of the raw inbound request).
 */
export function httpStreamTarget(ctx: HttpContext): StreamTarget {
  const res = ctx.response.response
  return {
    sink: res as unknown as SseSink,
    flushHeaders() {
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache, no-transform')
      res.setHeader('Connection', 'keep-alive')
      res.flushHeaders()
    },
    disconnect() {
      return onRequestDisconnect(ctx)
    },
  }
}

/**
 * The mutable state of one in-flight streamed call, threaded through the extracted
 * `#preflight` / `#pump` / `#classifyCaught` / `#settleAndRelease` helpers so the
 * orchestrator stays readable without turning the whole thing into one long method.
 * The collaborators are `readonly`; the four fields the pump and catch mutate
 * (`committed`, `heartbeat`, `reason`, `preflightError`) are the only writable ones,
 * so the state machine is easy to follow: exactly those four move.
 */
interface StreamRun {
  readonly target: StreamTarget
  readonly writer: SseWriter
  readonly pipeline: FragmentPipeline
  readonly disconnect: { signal: AbortSignal; dispose: () => void }
  readonly budget: AbortController
  readonly composed: AbortSignal | undefined
  readonly reservation: QuotaReservation
  readonly heartbeatMs: number
  committed: boolean
  heartbeat: ReturnType<typeof setInterval> | undefined
  reason: StreamAbortReason | undefined
  preflightError: StreamPreflightError | undefined
}

/**
 * Pumps a provider's fragment stream to the client over SSE, metering cost per
 * chunk against a reservation and resolving a {@link StreamResult}. It is a thin
 * orchestrator over three collaborators: the {@link SseWriter} (frames,
 * backpressure, heartbeat, socket errors), the {@link FragmentPipeline}
 * (validate + token accounting), and the pump loop below. Register it as a
 * container singleton (its quota / breaker deps are resolved via the container).
 *
 * Lifecycle: pre-flight (breaker + reserve) can resolve `failed_preflight`
 * before any byte; the first fragment (or a clean empty end) is the commit point
 * after which nothing throws to the caller; the `finally` always settles the used
 * tokens and releases the remainder, fail-open so a transient Redis blip can
 * never break it (the mistake this design guards against).
 */
export default class StreamExtensionService {
  readonly #quota: StreamQuota
  readonly #breaker: StreamBreaker | undefined
  readonly #runExtension: RunExtension
  readonly #isTimeoutError: (error: unknown) => boolean
  readonly #emitMetric: EmitMetric
  readonly #withSpan: WithSpan

  constructor(deps: StreamExtensionServiceDeps) {
    this.#quota = deps.quota
    this.#breaker = deps.breaker
    this.#runExtension = deps.runExtension
    this.#isTimeoutError = deps.isTimeoutError ?? (() => false)
    this.#emitMetric = deps.emitMetric ?? (() => {})
    this.#withSpan = deps.withSpan ?? ((_name, _attrs, fn) => fn())
  }

  /**
   * Wrap the streamed call in an `ai.stream` span (tenant/provider/model
   * attributes only, never content) and emit integer usage metrics on the
   * outcome. The span attributes and every metric value are integers or short
   * identifiers; no prompt or response text ever reaches telemetry.
   */
  async stream(
    target: StreamTarget,
    produce: StreamProducer,
    options: StreamExtensionOptions
  ): Promise<StreamResult> {
    const attrs: Record<string, string> = { 'tenant.id': options.tenant.id }
    if (options.provider) attrs.provider = options.provider
    if (options.model) attrs.model = options.model

    const result = await this.#withSpan('ai.stream', attrs, () =>
      this.#runStream(target, produce, options)
    )
    this.#emitOutcomeMetrics(options.tenant.id, result)
    return result
  }

  /** Best-effort integer metrics. A metrics-backend failure is swallowed. */
  #metric(tenantId: string, name: string, value: number): void {
    try {
      void Promise.resolve(this.#emitMetric(tenantId, name, value)).catch(() => {})
    } catch {
      /* best-effort */
    }
  }

  #emitOutcomeMetrics(tenantId: string, result: StreamResult): void {
    this.#metric(tenantId, 'ai_requests', 1)
    if (result.outcome === 'completed' || result.outcome === 'aborted') {
      this.#metric(tenantId, 'ai_tokens_total', result.tokensSettled)
    }
    if (result.outcome === 'aborted') {
      this.#metric(tenantId, 'ai_errors', 1)
      if (result.reason === 'client_disconnect') {
        this.#metric(tenantId, 'ai_stream_disconnects', 1)
      }
    }
  }

  async #runStream(
    target: StreamTarget,
    produce: StreamProducer,
    options: StreamExtensionOptions
  ): Promise<StreamResult> {
    // 1. Pre-flight, before any byte. A failure resolves failed_preflight so the
    //    caller can still set an HTTP status.
    const pre = await this.#preflight(options)
    if ('failed' in pre) return { outcome: 'failed_preflight', error: pre.failed }

    // 2. Set up the collaborators + the four-way composed abort, then pump.
    const run = this.#setup(target, options, pre.reservation)
    try {
      await this.#runExtension((signal) => this.#pump(run, produce, signal), {
        label: options.label,
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(run.composed !== undefined ? { signal: run.composed } : {}),
      })
      if (run.reason === undefined && run.composed?.aborted) {
        run.reason = attributeAbort(
          options.livenessSignal,
          run.disconnect.signal,
          run.budget.signal
        )
      }
    } catch (error) {
      await this.#classifyCaught(run, error)
    } finally {
      await this.#settleAndRelease(run)
    }

    // 3. Assemble the result from what the run recorded.
    if (!run.committed) {
      return { outcome: 'failed_preflight', error: run.preflightError ?? 'provider_unavailable' }
    }
    const base = {
      tokensSettled: run.pipeline.cumulative,
      fragments: run.pipeline.count,
      lastEventId: run.writer.lastEventId,
    }
    return run.reason === undefined
      ? { outcome: 'completed', ...base }
      : { outcome: 'aborted', reason: run.reason, ...base }
  }

  /**
   * The pre-commit gate: the breaker and the quota reservation. Either resolves a
   * reservation to pump against, or a `failed` pre-flight error the caller maps to a
   * status. Nothing here has flushed a byte, so a failure is always recoverable.
   */
  async #preflight(
    options: StreamExtensionOptions
  ): Promise<{ reservation: QuotaReservation } | { failed: StreamPreflightError }> {
    if (this.#breaker) {
      try {
        await this.#breaker.run(options.tenant.id)
      } catch {
        return { failed: 'provider_unavailable' }
      }
    }
    try {
      return {
        reservation: await this.#quota.reserve(options.tenant, options.quota, options.worstCase),
      }
    } catch (error) {
      return { failed: classifyReserveError(error) }
    }
  }

  /** Build the collaborators and the four-way composed abort into a fresh run state. */
  #setup(
    target: StreamTarget,
    options: StreamExtensionOptions,
    reservation: QuotaReservation
  ): StreamRun {
    const disconnect = target.disconnect()
    const budget = new AbortController()
    return {
      target,
      writer: new SseWriter(target.sink, { lastEventId: options.lastEventId }),
      pipeline: new FragmentPipeline(options.validateFragment, options.worstCase),
      disconnect,
      budget,
      composed: composeSignals([options.livenessSignal, disconnect.signal, budget.signal]),
      reservation,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      committed: false,
      heartbeat: undefined,
      reason: undefined,
      preflightError: undefined,
    }
  }

  /**
   * The commit point: flush the headers and start the heartbeat, exactly once.
   * After it, nothing throws to the caller (the stream is live), so every path that
   * writes a byte or ends cleanly calls it first.
   */
  #commit(run: StreamRun): void {
    if (run.committed) return
    run.committed = true
    run.target.flushHeaders()
    run.heartbeat = setInterval(() => {
      try {
        run.writer.writeHeartbeat()
      } catch {
        // socket is dead; the next fragment write surfaces it and aborts
      }
    }, run.heartbeatMs)
    if (typeof run.heartbeat.unref === 'function') run.heartbeat.unref()
  }

  /**
   * Pump the producer's fragments to the client: validate/admit, commit on the first
   * one, write, account, settle-after-write (fail-open), and stop on a rejected
   * fragment, a broken socket, or an exhausted budget. A clean end (including zero
   * fragments) still commits, so an empty stream resolves completed.
   */
  async #pump(run: StreamRun, produce: StreamProducer, signal: AbortSignal): Promise<void> {
    for await (const fragment of produce(signal)) {
      if (signal.aborted) break
      const admitted = run.pipeline.admit(fragment)
      if (admitted === null) {
        this.#commit(run)
        run.reason = 'fragment_rejected'
        break
      }
      this.#commit(run)
      try {
        await run.writer.writeFragment(admitted)
      } catch {
        run.reason = 'client_disconnect' // a broken socket write is a disconnect
        break
      }
      run.pipeline.account(admitted)
      // settle-after-write, fail-open: a drop between write and settle is still
      // charged by the finally; a settle blip never aborts the stream.
      try {
        await this.#quota.settle(run.reservation, run.pipeline.cumulative)
      } catch {
        /* fail-open */
      }
      if (run.pipeline.budgetExhausted) {
        run.budget.abort()
        run.reason = 'budget'
        break
      }
    }
    // A clean end (including zero fragments) commits an empty stream so it resolves
    // completed, not failed_preflight.
    this.#commit(run)
  }

  /**
   * Classify a caught error against the commit point. Pre-commit, it becomes a
   * pre-flight error the caller maps to a status (a fatal typed refusal keeps its own
   * code). Post-commit, a timeout is an abort reason, and any other provider error is
   * an in-band error frame (code only, never an upstream body) then a clean close.
   */
  async #classifyCaught(run: StreamRun, error: unknown): Promise<void> {
    if (!run.committed) {
      run.preflightError = this.#isTimeoutError(error)
        ? 'provider_unavailable'
        : classifyProducerError(error)
    } else if (this.#isTimeoutError(error)) {
      run.reason = 'timeout'
    } else {
      run.reason = 'provider_error'
      const code = error instanceof AIException ? error.aiCode : 'provider_error'
      try {
        await run.writer.writeErrorEvent(code)
      } catch {
        /* socket already gone */
      }
    }
  }

  /**
   * The fail-open teardown: stop the heartbeat, settle the used tokens and release
   * the remainder, and dispose the writer and disconnect wiring. A transient Redis
   * blip on settle or release must never throw out of here, so
   * every step swallows, and release runs exactly once.
   */
  async #settleAndRelease(run: StreamRun): Promise<void> {
    if (run.heartbeat) clearInterval(run.heartbeat)
    try {
      await this.#quota.settle(run.reservation, run.pipeline.cumulative)
    } catch {
      /* fail-open */
    }
    try {
      await this.#quota.release(run.reservation)
    } catch {
      /* fail-open */
    }
    run.writer.dispose()
    run.disconnect.dispose()
  }
}

/** Map a reserve failure onto a pre-flight error by its stable exception code. */
function classifyReserveError(error: unknown): StreamPreflightError {
  const code = (error as { code?: string } | null)?.code
  if (code === 'E_TENANT_QUOTA_EXCEEDED') return 'over_budget'
  if (code === 'E_DEPENDENCY_UNAVAILABLE') return 'rate_limit_unavailable'
  // An unexpected reserve failure fails closed (the reservation backend is the
  // budget gate); a 503-class error is the safe pre-flight answer.
  return 'rate_limit_unavailable'
}

/**
 * Map a pre-first-byte provider failure onto a pre-flight error. A typed
 * AIException keeps its own code (and thus its pinned status and retryability);
 * an untyped failure is a provider outage (retryable 503). Preserving the code
 * is load-bearing: a fatal refusal (model allow-list -> provider_not_allowed
 * 403, BYOK-endpoint block -> byok_endpoint_blocked 400) must not surface as a
 * retryable 503, or a client retry loop hammers a permanently-denied model or
 * endpoint.
 */
function classifyProducerError(error: unknown): StreamPreflightError {
  return error instanceof AIException ? error.aiCode : 'provider_unavailable'
}

/** Attribute a post-commit abort to the signal that fired (priority order). */
function attributeAbort(
  liveness: AbortSignal | undefined,
  disconnect: AbortSignal,
  budget: AbortSignal
): StreamAbortReason {
  if (liveness?.aborted) return 'tenant_suspended'
  if (disconnect.aborted) return 'client_disconnect'
  if (budget.aborted) return 'budget'
  return 'timeout' // executeExtension's internal timeout aborted the fn signal
}

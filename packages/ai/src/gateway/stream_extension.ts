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
  timeoutMs?: number
  /** The I8 fragment guard; returning null aborts without writing the leaking bytes. */
  validateFragment: (fragment: StreamFragment) => StreamFragment | null
  /** G11: aborts the stream when the tenant is suspended or deleted mid-flight. */
  livenessSignal?: AbortSignal
  /** SSE heartbeat interval. Default {@link DEFAULT_HEARTBEAT_MS}. */
  heartbeatMs?: number
  /** Resume cursor from the client's Last-Event-ID. */
  lastEventId?: string
  /** Provider name, for the span attribute only (never content). */
  provider?: string
  /** Model name, for the span attribute only (never content). */
  model?: string
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
 * retryability come from the exception's single-source-of-truth table
 * (`httpStatusForAiCode` / `FATAL_CODES`), so a fatal typed refusal thrown
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
 * never break it (the I3-violating mistake this design guards against).
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
   * identifiers; no prompt or response text ever reaches telemetry (G3).
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
    if (this.#breaker) {
      try {
        await this.#breaker.run(options.tenant.id)
      } catch {
        return { outcome: 'failed_preflight', error: 'provider_unavailable' }
      }
    }

    let reservation: QuotaReservation
    try {
      reservation = await this.#quota.reserve(options.tenant, options.quota, options.worstCase)
    } catch (error) {
      return { outcome: 'failed_preflight', error: classifyReserveError(error) }
    }

    // 2. Set up the collaborators + the four-way composed abort.
    const writer = new SseWriter(target.sink, { lastEventId: options.lastEventId })
    const pipeline = new FragmentPipeline(options.validateFragment, options.worstCase)
    const disconnect = target.disconnect()
    const budget = new AbortController()
    const composed = composeSignals([options.livenessSignal, disconnect.signal, budget.signal])
    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS

    let heartbeat: ReturnType<typeof setInterval> | undefined
    let committed = false
    const commit = () => {
      if (committed) return
      committed = true
      target.flushHeaders() // the commit point: after this nothing throws to the caller
      heartbeat = setInterval(() => {
        try {
          writer.writeHeartbeat()
        } catch {
          // socket is dead; the next fragment write surfaces it and aborts
        }
      }, heartbeatMs)
      if (typeof heartbeat.unref === 'function') heartbeat.unref()
    }

    let reason: StreamAbortReason | undefined
    let preflightError: StreamPreflightError | undefined

    try {
      await this.#runExtension(
        async (signal) => {
          for await (const fragment of produce(signal)) {
            if (signal.aborted) break
            const admitted = pipeline.admit(fragment)
            if (admitted === null) {
              commit()
              reason = 'fragment_rejected'
              break
            }
            commit()
            try {
              await writer.writeFragment(admitted)
            } catch {
              reason = 'client_disconnect' // a broken socket write is a disconnect
              break
            }
            pipeline.account(admitted)
            // settle-after-write, fail-open: a drop between write and settle is
            // still charged by the finally; a settle blip never aborts the stream.
            try {
              await this.#quota.settle(reservation, pipeline.cumulative)
            } catch {
              /* fail-open */
            }
            if (pipeline.budgetExhausted) {
              budget.abort()
              reason = 'budget'
              break
            }
          }
          // A clean end (including zero fragments) commits an empty stream so it
          // resolves completed, not failed_preflight.
          commit()
        },
        { label: options.label, timeoutMs: options.timeoutMs, signal: composed }
      )
      if (reason === undefined && composed?.aborted) {
        reason = attributeAbort(options.livenessSignal, disconnect.signal, budget.signal)
      }
    } catch (error) {
      if (!committed) {
        // The provider failed before the first byte: map it to a status.
        preflightError = this.#isTimeoutError(error)
          ? 'provider_unavailable'
          : classifyProducerError(error)
      } else if (this.#isTimeoutError(error)) {
        reason = 'timeout'
      } else {
        // A provider error mid-stream: an in-band error frame (code only, never an
        // upstream body), then a clean close. Never throws past flushed headers.
        reason = 'provider_error'
        const code = error instanceof AIException ? error.aiCode : 'provider_error'
        try {
          await writer.writeErrorEvent(code)
        } catch {
          /* socket already gone */
        }
      }
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      // Fail-open final settle + release: a transient Redis blip here must never
      // throw out of the finally (the I3 violation this guards against).
      try {
        await this.#quota.settle(reservation, pipeline.cumulative)
      } catch {
        /* fail-open */
      }
      try {
        await this.#quota.release(reservation)
      } catch {
        /* fail-open */
      }
      writer.dispose()
      disconnect.dispose()
    }

    if (!committed) {
      return { outcome: 'failed_preflight', error: preflightError ?? 'provider_unavailable' }
    }
    const base = {
      tokensSettled: pipeline.cumulative,
      fragments: pipeline.count,
      lastEventId: writer.lastEventId,
    }
    return reason === undefined
      ? { outcome: 'completed', ...base }
      : { outcome: 'aborted', reason, ...base }
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

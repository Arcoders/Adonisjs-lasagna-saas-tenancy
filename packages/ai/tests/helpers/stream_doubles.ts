import type { QuotaReservation } from '@adonisjs-lasagna/saas-tenancy/services'
import { composeSignals } from '@adonisjs-lasagna/saas-tenancy/signals'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import StreamExtensionService, {
  type RunExtension,
  type StreamBreaker,
  type StreamProducer,
  type StreamQuota,
  type StreamTarget,
} from '../../src/gateway/stream_extension.js'
import type { StreamFragment } from '../../src/types/ai_provider_contract.js'
import { FakeSseSink } from './fake_sse_sink.js'

export const fakeTenant = { id: 't1' } as unknown as TenantModelContract

/** A StreamTarget backed by a fake sink with a controllable disconnect signal. */
export class FakeStreamTarget implements StreamTarget {
  readonly sink = new FakeSseSink()
  flushed = false
  disposedDisconnect = false
  readonly #disconnect = new AbortController()

  flushHeaders(): void {
    this.flushed = true
  }

  disconnect(): { signal: AbortSignal; dispose: () => void } {
    return {
      signal: this.#disconnect.signal,
      dispose: () => {
        this.disposedDisconnect = true
      },
    }
  }

  /** Simulate the client dropping the socket. */
  abortDisconnect(): void {
    this.#disconnect.abort()
  }

  get output(): string {
    return this.sink.output
  }
}

/** A quota seam double: records settles + releases, can inject failures. */
export class FakeQuota implements StreamQuota {
  reserveError: unknown
  settleError: unknown
  releaseError: unknown
  readonly settles: number[] = []
  releases = 0

  readonly reservation: QuotaReservation = {
    id: 'r1',
    tenantId: 't1',
    quota: 'ai',
    day: '2026-07-01',
    worstCase: 100,
    ttl: 60,
    op: false,
  }

  async reserve(): Promise<QuotaReservation> {
    if (this.reserveError) throw this.reserveError
    return this.reservation
  }

  async settle(_reservation: QuotaReservation, cumulativeUsed: number): Promise<void> {
    if (this.settleError) throw this.settleError
    this.settles.push(cumulativeUsed)
  }

  async release(): Promise<number> {
    if (this.releaseError) throw this.releaseError
    this.releases += 1
    return 0
  }
}

/** A breaker seam double. */
export class FakeBreaker implements StreamBreaker {
  open = false

  async run(): Promise<void> {
    if (this.open) {
      throw Object.assign(new Error('breaker open'), { code: 'EOPENBREAKER' })
    }
  }
}

/** An error carrying a stable core exception code, for the reserve-failure paths. */
export function codedError(code: string): Error {
  return Object.assign(new Error(code), { code })
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Stands in for core's ExtensionTimeoutError so the unit tests need no core barrel. */
export class FakeTimeoutError extends Error {}
export const isFakeTimeout = (error: unknown): boolean => error instanceof FakeTimeoutError

/**
 * A faithful mimic of core's `executeExtension` for the unit tier: it composes
 * the caller signal with an internal timeout controller on BOTH paths (including
 * the no-timeout fast path, the PR-5 behavior), and rejects with a
 * {@link FakeTimeoutError} when the deadline wins. Uses the real (redis-free)
 * `composeSignals` from `/signals`.
 */
export const fakeRunExtension: RunExtension = async (fn, options) => {
  const controller = new AbortController()
  const signal = composeSignals([controller.signal, options.signal]) ?? controller.signal
  if (!options.timeoutMs) return fn(signal)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort()
      reject(new FakeTimeoutError(`timed out after ${options.timeoutMs}ms`))
    }, options.timeoutMs)
  })
  try {
    return await Promise.race([fn(signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Build a StreamExtensionService wired with the fake runner + timeout classifier. */
export function makeService(
  quota: FakeQuota = new FakeQuota(),
  breaker: FakeBreaker = new FakeBreaker()
): { svc: StreamExtensionService; quota: FakeQuota; breaker: FakeBreaker } {
  const svc = new StreamExtensionService({
    quota,
    breaker,
    runExtension: fakeRunExtension,
    isTimeoutError: isFakeTimeout,
  })
  return { svc, quota, breaker }
}

/** A producer that yields the given fragments, honoring the abort signal. */
export function fragmentsProducer(fragments: StreamFragment[]): StreamProducer {
  return async function* (signal: AbortSignal) {
    for (const fragment of fragments) {
      if (signal.aborted) return
      yield fragment
    }
  }
}

/**
 * A producer that yields fragments and runs `afterFirst` right after the first
 * yield (so a test can trip a liveness / disconnect abort mid-stream), then
 * honors the signal on the next pull.
 */
export function hookedProducer(
  fragments: StreamFragment[],
  afterFirst: () => void
): StreamProducer {
  return async function* (signal: AbortSignal) {
    let i = 0
    for (const fragment of fragments) {
      if (signal.aborted) return
      yield fragment
      if (i === 0) afterFirst()
      i += 1
    }
  }
}

/**
 * A tiny, dependency-free concurrent HTTP client for the correctness tiers.
 *
 * autocannon (used by the throughput tier) pre-renders requests and does NOT
 * let you correlate a specific request with its specific response — which is
 * exactly what an isolation assertion needs ("the response to a request for
 * tenant A must contain only tenant A's data"). So those tiers drive load with
 * this client instead: `workers` parallel loops, each pulling the next index
 * off a shared counter, issuing the request `pickRequest(i)` returns, and
 * running `check()` against the parsed body. Any failed check is counted as a
 * mismatch (the isolation/correctness failure), separate from transport errors.
 */

export interface ConcurrentRequest {
  path: string
  method?: string
  headers?: Record<string, string>
  body?: string
  /** Carried through to `check` so the assertion knows what was asked for. */
  meta?: Record<string, unknown>
}

export interface CheckVerdict {
  ok: boolean
  /** Short human reason when `ok` is false; sampled into the result. */
  reason?: string
  /**
   * Set true when a non-ok verdict is an availability/transport problem (e.g. a
   * non-200 status), NOT a content mismatch. Counted as an `error`, never as a
   * `mismatch`, so an outage or a 5xx hiccup can't masquerade as a leak signal.
   */
  error?: boolean
}

export interface ConcurrentResult {
  total: number
  ok: number
  /** Responses that failed the correctness `check` (the leak signal). */
  mismatches: number
  /** Transport/parse failures (not correctness failures). */
  errors: number
  statusHistogram: Record<number, number>
  latencyNs: number[]
  /** Up to 10 sampled mismatch reasons (correctness leaks), for the log. */
  sampleMismatches: string[]
  /** Up to 10 sampled transport/availability error reasons, for the log. */
  sampleErrors: string[]
}

export interface ConcurrentOptions {
  baseUrl: string
  workers: number
  totalRequests: number
  pickRequest: (index: number) => ConcurrentRequest
  check: (req: ConcurrentRequest, status: number, body: unknown) => CheckVerdict
  /** Optional per-request timeout (ms). Default 10_000. */
  timeoutMs?: number
}

export async function runConcurrent(opts: ConcurrentOptions): Promise<ConcurrentResult> {
  const { baseUrl, workers, totalRequests, pickRequest, check, timeoutMs = 10_000 } = opts
  const result: ConcurrentResult = {
    total: 0,
    ok: 0,
    mismatches: 0,
    errors: 0,
    statusHistogram: {},
    latencyNs: [],
    sampleMismatches: [],
    sampleErrors: [],
  }

  let next = 0
  // A mismatch is a correctness/leak signal; an error is a transport or
  // availability failure. They are counted separately so a flaky request can
  // never be read as a cross-tenant leak.
  const recordMismatch = (reason: string) => {
    result.mismatches++
    if (result.sampleMismatches.length < 10) result.sampleMismatches.push(reason)
  }
  const recordError = (reason: string) => {
    result.errors++
    if (result.sampleErrors.length < 10) result.sampleErrors.push(reason)
  }

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= totalRequests) return
      const req = pickRequest(i)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const t0 = process.hrtime.bigint()
      try {
        const res = await fetch(`${baseUrl}${req.path}`, {
          method: req.method ?? 'GET',
          ...(req.headers !== undefined ? { headers: req.headers } : {}),
          ...(req.body !== undefined ? { body: req.body } : {}),
          signal: controller.signal,
        })
        result.latencyNs.push(Number(process.hrtime.bigint() - t0))
        result.total++
        result.statusHistogram[res.status] = (result.statusHistogram[res.status] ?? 0) + 1

        let body: unknown = null
        try {
          body = await res.json()
        } catch {
          // Non-JSON body (e.g. an error page); leave as null for `check`.
        }

        const verdict = check(req, res.status, body)
        if (verdict.ok) result.ok++
        else if (verdict.error)
          recordError(verdict.reason ?? `request ${i}: availability error (status ${res.status})`)
        else recordMismatch(verdict.reason ?? `request ${i}: failed check (status ${res.status})`)
      } catch (err) {
        result.total++
        recordError(`request ${i}: transport error ${(err as Error)?.message ?? String(err)}`)
      } finally {
        clearTimeout(timer)
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, workers) }, () => worker()))
  return result
}

/** p-th percentile of an unsorted ns sample (0 if empty). */
export function percentileNs(samples: number[], p: number): number {
  if (samples.length === 0) return 0
  const sorted = [...samples].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  // `idx` is clamped to [0, length-1] and `sorted` is non-empty (guarded above).
  return sorted[idx]!
}

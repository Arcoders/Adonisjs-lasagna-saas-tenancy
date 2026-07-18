import { runMicro, type BenchResult } from '../harness/runner.js'
import { createGuardAudit, tokenizeTenantId } from './internal.js'

const GROUP = 'isthmus'

/**
 * Prices the Isthmus machinery that runs when a guard TRIPS: the shared
 * guard-audit `emit` (counter bumps + the rate-limiter window + the
 * fire-and-forget dispatch decision), the `allow` window check on its own, and
 * the `tokenizeTenantId` HMAC that keeps a foreign tenant id out of a broadcast
 * event (S1). Pure CPU, no app, no DB. The steady-state path (once a severity's
 * dispatch budget is spent within its window) is the rate-limited one, so these
 * measure the cost a burst actually pays.
 *
 * The seal happy-path (the per-read `!==` over the request memo) is a plain
 * string compare and is not separately priced here; the tested op-count invariant
 * (`@guarantees/performance`) is what pins that it adds zero round-trips.
 */
export function runIsthmus(): BenchResult[] {
  const BROADCAST = {
    id: 'guard.bench_broadcast',
    pillar: 'guard' as const,
    bugClass: 'bench',
    severity: 'high' as const,
    event: 'isthmus:guard:bench:rejected',
  }
  const COUNT_ONLY = { ...BROADCAST, id: 'guard.bench_count_only', dispatchPolicy: 'count-only' as const }

  const broadcastAudit = createGuardAudit({ lookup: () => BROADCAST })
  broadcastAudit.setDispatcher(async () => {})

  const countOnlyAudit = createGuardAudit({ lookup: () => COUNT_ONLY })
  countOnlyAudit.setDispatcher(async () => {})

  const rateAudit = createGuardAudit({ lookup: () => BROADCAST })

  const ids = Array.from(
    { length: 64 },
    (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`
  )
  let tokIdx = 0
  let now = 1

  return [
    runMicro('emit (count-only, counters only)', () => countOnlyAudit.emit('guard.bench_count_only'), {
      group: GROUP,
    }),
    runMicro('emit (broadcast, steady-state)', () => broadcastAudit.emit('guard.bench_broadcast'), {
      group: GROUP,
    }),
    runMicro('allow (rate-limiter window check)', () => rateAudit.allow('high', now++), {
      group: GROUP,
    }),
    runMicro('tokenizeTenantId (foreign-id HMAC)', () => tokenizeTenantId(ids[tokIdx++ % ids.length]!), {
      group: GROUP,
    }),
  ]
}

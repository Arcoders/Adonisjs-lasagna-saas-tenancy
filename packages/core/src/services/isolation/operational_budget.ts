import { getStore } from '../../config_store.js'

/**
 * The OPERATIONAL connection budget: how many connections the bulk/parallel
 * operational paths (the F1 migration worker pool, the F2 warm pool,
 * satellite-migration temp clones) may hold open at once.
 *
 * Operational work is bursty and must never crowd out request-serving
 * connections, so the default is small. It is bounded [1, {@link
 * MAX_OPERATIONAL_CONNECTION_BUDGET}] at boot (via `numeric_config_fields`) and,
 * more importantly, clamped at RUNTIME to the absolute, unbypassable
 * `maxTenantConnectionsHardCeiling` (S2). That clamp is the real invariant: a
 * parallel/warm pool draws only from this budget, so it can never push the pool
 * past the ceiling, and the ceiling can never exhaust PostgreSQL.
 */
export const DEFAULT_OPERATIONAL_CONNECTION_BUDGET = 4

/** Sanity upper bound on the CONFIGURED budget; the ceiling clamp bounds it further. */
export const MAX_OPERATIONAL_CONNECTION_BUDGET = 64

/**
 * Resolve the effective operational connection budget: the configured value
 * (default {@link DEFAULT_OPERATIONAL_CONNECTION_BUDGET}), clamped so it can never
 * exceed the absolute ceiling. When no ceiling is set the configured budget
 * stands. Always >= 1.
 *
 * Reads the config store directly (not `getConfig()`) so it tolerates an
 * unbooted process (a bare unit runner exercising the migration runner) by
 * falling back to the default rather than throwing.
 */
export function resolveOperationalConnectionBudget(): number {
  const iso = getStore().current?.isolation
  const budget = iso?.operationalConnectionBudget ?? DEFAULT_OPERATIONAL_CONNECTION_BUDGET
  const ceiling = iso?.maxTenantConnectionsHardCeiling
  const effective = ceiling === undefined ? budget : Math.min(budget, ceiling)
  return Math.max(1, effective)
}

// FIFO counting semaphore state, process-wide. Bulk/parallel operational paths
// that each open a real connection run inside runWithinOperationalBudget, so
// their COMBINED open connections can never exceed the operational budget (itself
// clamped to the ceiling), even when a caller fans work out without its own clamp.
let permitsInUse = 0
const waiters: Array<() => void> = []

/**
 * Run `fn` holding one operational-connection permit, admitting at most
 * {@link resolveOperationalConnectionBudget} holders at once and queueing the
 * rest FIFO. The permit is always released, including on throw, so a failing
 * operation never leaks a permit.
 *
 * The `while` re-checks the count after each wake (not a one-shot `if`), so a
 * woken waiter that finds the budget re-consumed by a peer waits again rather
 * than racing past the limit.
 */
export async function runWithinOperationalBudget<T>(fn: () => Promise<T>): Promise<T> {
  const limit = resolveOperationalConnectionBudget()
  while (permitsInUse >= limit) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  permitsInUse++
  try {
    return await fn()
  } finally {
    permitsInUse--
    waiters.shift()?.()
  }
}

/** Test seam: the live in-use permit count, for asserting the budget is honored. */
export function __operationalPermitsInUse(): number {
  return permitsInUse
}

/**
 * Resolve the effective concurrency for a bulk migration run (F1). A `requested`
 * value (a `--concurrency` flag) is clamped into `[1, operationalConnectionBudget]`
 * so a parallel migration can never open more connections than the operational
 * budget allows (and thus never breach the absolute ceiling). Omitting `requested`
 * defaults to 1 (sequential), so the batch is opt-in and non-disruptive.
 */
export function resolveMigrationConcurrency(requested?: number): number {
  const budget = resolveOperationalConnectionBudget()
  if (requested === undefined || !Number.isFinite(requested)) return 1
  return Math.max(1, Math.min(Math.floor(requested), budget))
}

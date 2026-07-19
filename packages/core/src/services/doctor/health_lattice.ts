/**
 * The health lattice: the model that makes "a fix only ever moves a tenant toward
 * health, and never destroys data" a checkable proposition rather than a hope.
 *
 * A tenant's state is `S(t) = (H(t), D(t))`:
 *   - `H(t)` — a HealthVector over FIVE independent axes, each a small ordinal from ⊥
 *     (worst) up. The order is the PRODUCT order: `H(a) ≥ H(b)` iff every axis of `a`
 *     is ≥ the matching axis of `b`. The ordinals are chosen so "accurate + actionable"
 *     outranks "stuck + lying": a `failed` tenant (heal-recoverable) is ABOVE a stalled
 *     `provisioning` one (inert), and an `active` row carrying a `deletedAt` (an
 *     Invariant-A violation — serving a lie) is the bottom of the lifecycle axis.
 *   - `D(t)` — the physical data fingerprint (row counts + object structure). Its order
 *     is additive-only: `D(a) ⊒ D(b)` iff `a` has every row/object `b` had (a fix may
 *     add storage, never remove it).
 *
 * A fix `f` is do-no-harm iff for every reachable pre-state: `H(f(t)) ≥ H(t)`,
 * `D(f(t)) ⊒ D(t)` (with EQUALITY for physical-identity / status-only / operational-only
 * fixes, which touch no data), it is idempotent, and it is fail-closed (identity + a
 * refusal on any precondition miss). This module is the shared vocabulary for that
 * property. The property itself is exercised behaviorally on real Postgres per effect
 * class — the ledger-reconcile resilience spec asserts `D` is byte-preserved across a
 * physical-identity rewrite, and the tenant-heal resilience + fault-injection specs assert
 * an additive-only heal never drops/resets/downs and surfaces a collision rather than
 * retrying destructively. The unit test here pins the lattice's ordering algebra.
 */

export interface HealthVector {
  /** Lifecycle consistency + serviceability (status vs deletedAt). */
  lifecycle: number
  /** Per-tenant storage presence. */
  storage: number
  /** Migration-ledger fidelity (at head + names match the source). */
  ledgerFidelity: number
  /** Runtime circuit-breaker state. */
  runtimeCircuit: number
  /** Recoverability from a failed state. */
  recoverability: number
}

/** The lifecycle-axis ordinal, from the tenant's observable status + deletedAt consistency. */
export function lifecycleLevel(status: string, deletedAtPresent: boolean): number {
  // active/deleted with a CONSISTENT deletedAt are the top (accurate + serviceable or
  // accurately terminal); a status/deletedAt divergence is the bottom (serving a lie).
  if (status === 'active') return deletedAtPresent ? 0 : 4
  if (status === 'deleted') return deletedAtPresent ? 4 : 0
  if (status === 'suspended') return 3
  if (status === 'failed') return 2 // inconsistent but heal-recoverable
  if (status === 'provisioning') return 1 // inert / stuck if it never finishes
  return 0
}

/** `H(a) ≥ H(b)` in the product order: every axis of `a` is ≥ the matching axis of `b`. */
export function healthGe(a: HealthVector, b: HealthVector): boolean {
  return (
    a.lifecycle >= b.lifecycle &&
    a.storage >= b.storage &&
    a.ledgerFidelity >= b.ledgerFidelity &&
    a.runtimeCircuit >= b.runtimeCircuit &&
    a.recoverability >= b.recoverability
  )
}

/** `H(a) = H(b)` — equal on every axis. */
export function healthEq(a: HealthVector, b: HealthVector): boolean {
  return healthGe(a, b) && healthGe(b, a)
}

/** True when `a` is strictly healthier than `b` (≥ on all axes, > on at least one). */
export function healthGt(a: HealthVector, b: HealthVector): boolean {
  return healthGe(a, b) && !healthEq(a, b)
}

/** The additive-only data order: `a` preserves every row-count and column `b` had. */
export type DataFingerprint = Map<string, { count: number; columns: string[] }>

/** `D(a) ⊒ D(b)`: `a` has every table `b` had, with ≥ its row count and ⊇ its columns. */
export function dataPreserves(a: DataFingerprint, b: DataFingerprint): boolean {
  for (const [table, bv] of b) {
    const av = a.get(table)
    if (!av) return false
    if (av.count < bv.count) return false
    for (const col of bv.columns) if (!av.columns.includes(col)) return false
  }
  return true
}

/** `D(a) = D(b)` — byte-identical fingerprint (required for non-additive effect classes). */
export function dataEqual(a: DataFingerprint, b: DataFingerprint): boolean {
  if (a.size !== b.size) return false
  for (const [table, av] of a) {
    const bv = b.get(table)
    if (!bv || av.count !== bv.count || av.columns.length !== bv.columns.length) return false
    for (let i = 0; i < av.columns.length; i++) if (av.columns[i] !== bv.columns[i]) return false
  }
  return true
}

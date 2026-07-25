import { lazyLogger } from '../utils/lazy_logger.js'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * What the request-path lifecycle floor should do with a resolved tenant:
 *  - `serve`             — the tenant is active; proceed.
 *  - `reject-suspended`  — a deliberately-held or soft-deleted tenant → 403 (the
 *                          `TenantSuspendedException`), decided BEFORE the authorizer.
 *  - `reject-not-ready`  — a provisioning or failed tenant → 503 (`TenantNotReady`),
 *                          decided AFTER the membership/authorizer chain.
 */
export type TenantLifecycleDisposition = 'serve' | 'reject-suspended' | 'reject-not-ready'

/**
 * The single, compile-time-exhaustive classifier for the request-path lifecycle floor.
 * The three floor sites (the tenant guard, the universal middleware, and
 * `request.tenant()`'s `assertTenantActive`) all route through this, so a new
 * `TenantStatus` cannot be added without deciding its disposition here: the
 * `assertNever` in the `default` branch turns an unhandled status into a COMPILE error.
 *
 * Takes the MODEL, not the bare status, because soft-deletion is an independent axis
 * (`isDeleted = deletedAt !== null`) that OUTRANKS status: a soft-deleted tenant is
 * rejected whatever its status column says. A status-only classifier would stop
 * rejecting a soft-deleted-but-`active` tenant — a real regression.
 *
 * Deliberate hardening delta: a tenant whose status is `deleted` but whose `deletedAt`
 * is null (an Invariant-A violation) is served today because no floor catches it; the
 * exhaustive classifier now rejects it, consistent with the doctor's
 * `lifecycle_deleted_without_timestamp` finding.
 */
export function tenantLifecycleDisposition(
  t: Pick<TenantModelContract, 'status' | 'isDeleted'>
): TenantLifecycleDisposition {
  if (t.isDeleted) return 'reject-suspended'
  switch (t.status) {
    case 'active':
      return 'serve'
    case 'suspended':
    case 'deleted':
      return 'reject-suspended'
    case 'provisioning':
    case 'failed':
      return 'reject-not-ready'
    default: {
      // Compile-time exhaustiveness: adding a TenantStatus without a case above makes
      // this assignment fail to build (the value stops being assignable to `never`).
      const _exhaustive: never = t.status
      void _exhaustive
      // Runtime backstop: `status: TenantStatus` is a compile-time type only — the DB
      // column is an unconstrained string, so legacy data, corruption, or a rolling
      // -deploy version skew can present an out-of-tuple value. FAIL CLOSED to
      // `reject-not-ready` (the universal middleware then degrades to central, the guard
      // returns a retry-able 503) rather than throwing a 500, honoring the floor's
      // contract of never throwing on an invalid tenant.
      lazyLogger.warn(
        `[multitenancy] tenant lifecycle floor: unrecognized status "${String((t as { status?: unknown }).status)}" — treating as not-ready (fail-closed)`
      )
      return 'reject-not-ready'
    }
  }
}

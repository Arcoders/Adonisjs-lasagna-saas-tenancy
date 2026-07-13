import { emitIsthmusEvent } from './audit.js'
import { isSafeIdentifier } from '../services/isolation/identifier.js'

/**
 * The guarded identifier surface: the single owner of the
 * `guard.tenant_identifier` Isthmus emit. It wraps the pure predicate in
 * `services/isolation/identifier.ts` with the observable guard behavior, so the
 * policy leaf stays a zero-import module and the dependency arrow points from
 * this guard layer DOWN to the predicate — never the reverse.
 *
 * Both refusal paths route their audit through here, closing the asymmetry that
 * TS-2 fixed: the throwing `assertSafeIdentifier` always emitted, but the
 * non-throwing degrade at attribution seams (rate-limit buckets, metric keys)
 * used to drop a forged id mutely. `guardedSafeIdentifier` now emits the same
 * event on that path. The isthmus audit is budget-rate-limited per severity, so
 * a burst of forged ids yields BOUNDED dispatch, and the per-id `rejected`
 * counter (the kernel's primary trip surface, not the event) stays accurate.
 *
 * One trade-off worth naming: `guard.tenant_identifier` is `high`, so these
 * degrade emits share the single per-severity dispatch window with the other
 * high guards (SSRF, RLS, webhook). A sustained forged-id flood can therefore
 * crowd out their EVENT dispatch (never their counters). That flood is only
 * reachable behind a lax CUSTOM resolver — the built-in resolvers gate id hits
 * on `isUuidV4`, so a forged non-UUID misses and never arrives at this seam as a
 * present value. A per-id sub-cap in the shared limiter (`sdk/guard_audit.ts`),
 * or a lower severity for the degrade, would remove even that residue.
 */

/** The one call site of the guard's emit. `value` is truncated for the payload. */
function emitRejection(kind: string, value: unknown): void {
  emitIsthmusEvent('guard.tenant_identifier', {
    metadata: { kind, value: String(value).slice(0, 64) },
  })
}

/**
 * Reject anything that could escape a quoted identifier in PostgreSQL DDL.
 * We never want to interpolate an unsafe string into `CREATE SCHEMA "…"`,
 * `DROP DATABASE "…"`, or any other identifier slot, so this check is the
 * first line of defense. Call it at the entry of every driver method that
 * uses `tenant.id` in raw SQL.
 *
 * Allows UUID v4 (the canonical id) and opaque alphanumeric ids of up to
 * 63 chars. Doubled `"` is the PG escape for embedded quotes inside a
 * quoted identifier, so a single `"` in the input would corrupt the DDL. We
 * reject before reaching SQL, emitting `guard.tenant_identifier` first.
 */
export function assertSafeIdentifier(value: string, kind: string = 'identifier'): void {
  if (!isSafeIdentifier(value)) {
    emitRejection(kind, value)
    throw new Error(
      `Refusing to use unsafe ${kind} "${value}" in DDL. ` +
        `Tenant ids must match /^[a-zA-Z0-9_-]{1,63}$/ in canonical (NFKC) form (UUID v4 satisfies this).`
    )
  }
}

/**
 * Audited, non-throwing twin of {@link assertSafeIdentifier}. Returns whether
 * `value` is a safe identifier and, when it is a PRESENT-but-unsafe value,
 * emits `guard.tenant_identifier` so a rejected id is never invisible. Use it
 * at attribution seams (rate-limit buckets, metric keys, log context) where a
 * resolved tenant id must never carry a `:` delimiter or any other injectable
 * character, but where the safe response is to drop/degrade rather than throw.
 *
 * An ABSENT id (`undefined` / `null` / `''`) is the ordinary "no tenant on this
 * route" degrade to the shared bucket, so it returns false WITHOUT emitting —
 * otherwise every untenanted request would trip the guard. Only a present id
 * that fails the policy (a forged or misconfigured custom-resolver id) audits.
 */
export function guardedSafeIdentifier(
  value: unknown,
  kind: string = 'identifier'
): value is string {
  if (isSafeIdentifier(value)) return true
  if (value !== undefined && value !== null && value !== '') emitRejection(kind, value)
  return false
}

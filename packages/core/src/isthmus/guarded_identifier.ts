import { emitIsthmusEvent } from './audit.js'
import { isSafeIdentifier } from '../services/isolation/identifier.js'

/**
 * The guarded identifier surface: the single owner of the
 * `guard.tenant_identifier` Isthmus emit. It wraps the pure predicate in
 * `services/isolation/identifier.ts` with the observable guard behavior, so the
 * policy leaf stays a zero-import module and the dependency arrow points from
 * this guard layer DOWN to the predicate, never the reverse.
 *
 * Both refusal paths route their audit through here, but each records on the
 * surface its stakes call for:
 *  - `assertSafeIdentifier` THROWS: a driver was about to interpolate an unsafe
 *    id into DDL or a Redis key (a near-miss injection). It bumps the counter AND
 *    broadcasts the fire-and-forget `IsthmusGuardTripped` event, so a host can
 *    react in real time.
 *  - `guardedSafeIdentifier` DEGRADES: an attribution seam drops a forged id to
 *    the shared bucket. It records the trip on the `rejected` counter but does
 *    NOT broadcast an event (`dispatch: false`). The forged attribution is still
 *    never invisible (it surfaces on the Prometheus `multitenancy_isthmus_*`
 *    counters, the kernel's primary trip surface), while a high-volume,
 *    attacker-influenceable degrade (only reachable behind a lax CUSTOM resolver,
 *    since the built-in resolvers gate id hits on `isUuidV4`) can never consume
 *    the `high` dispatch budget and crowd out a co-severity security guard's
 *    events (SSRF, RLS, webhook). The counter carries the volume signal and the
 *    event carries the near-miss, so each trip lands on the right surface.
 */

/**
 * The one call site of the guard's emit. `value` is truncated for the payload.
 * `dispatch` broadcasts the event (the throwing path) or records counter-only
 * (the degrade path); see the file header for why.
 */
function emitRejection(kind: string, value: unknown, dispatch: boolean): void {
  emitIsthmusEvent('guard.tenant_identifier', {
    metadata: { kind, value: String(value).slice(0, 64) },
    dispatch,
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
    emitRejection(kind, value, true)
    throw new Error(
      `Refusing to use unsafe ${kind} "${value}" in DDL. ` +
        `Tenant ids must match /^[a-zA-Z0-9_-]{1,63}$/ in canonical (NFKC) form (UUID v4 satisfies this).`
    )
  }
}

/**
 * Audited, non-throwing twin of {@link assertSafeIdentifier}. Returns whether
 * `value` is a safe identifier and, when it is a PRESENT-but-unsafe value,
 * records a `guard.tenant_identifier` trip on the counter (counter-only, no
 * event broadcast; see the file header) so a rejected id is never invisible.
 * Use it at attribution seams (rate-limit buckets, metric keys, log context)
 * where a resolved tenant id must never carry a `:` delimiter or any other
 * injectable character, but where the safe response is to drop/degrade rather
 * than throw.
 *
 * An ABSENT id (`undefined` / `null` / `''`) is the ordinary "no tenant on this
 * route" degrade to the shared bucket, so it returns false WITHOUT recording.
 * Otherwise every untenanted request would trip the guard. Only a present id
 * that fails the policy (a forged or misconfigured custom-resolver id) audits.
 */
export function guardedSafeIdentifier(
  value: unknown,
  kind: string = 'identifier'
): value is string {
  if (isSafeIdentifier(value)) return true
  if (value !== undefined && value !== null && value !== '') emitRejection(kind, value, false)
  return false
}

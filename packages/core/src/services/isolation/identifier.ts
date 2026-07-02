import { emitIsthmusEvent } from '../../isthmus/audit.js'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Strict identifier policy: alphanumerics, underscores, and hyphens only.
 * Length ≤ 63 to fit PostgreSQL's `NAMEDATALEN - 1`. Both UUID v4 (canonical
 * tenant id format) and short opaque ids that the host app may use satisfy
 * this regex.
 */
const SAFE_IDENT = /^[a-zA-Z0-9_-]{1,63}$/

/**
 * Defense-in-depth: a safe identifier must ALSO be in canonical NFKC form.
 *
 * NFKC folds compatibility/homoglyph characters onto ASCII (`℀`→`a/c`, `𝔸`→`A`,
 * fullwidth digits → ASCII digits). The correct posture for a tenant identifier
 * is to REJECT a non-canonical input, never to fold it: folding `tenant_℀` to
 * `tenant_A` would COLLIDE with a legitimate `tenant_A` schema, which is exactly
 * the homoglyph-collision risk this guards against. The ASCII-only `SAFE_IDENT`
 * already rejects every non-canonical character today, so this is belt-and-
 * suspenders: a future loosening of the regex still cannot admit a homoglyph.
 */
function isCanonicalForm(value: string): boolean {
  return value === value.normalize('NFKC')
}

/**
 * Reject anything that could escape a quoted identifier in PostgreSQL DDL.
 * We never want to interpolate an unsafe string into `CREATE SCHEMA "…"`,
 * `DROP DATABASE "…"`, or any other identifier slot, so this check is the
 * first line of defense — call it at the entry of every driver method that
 * uses `tenant.id` in raw SQL.
 *
 * Allows UUID v4 (the canonical id) and opaque alphanumeric ids of up to
 * 63 chars. Doubled `"` is the PG escape for embedded quotes inside a
 * quoted identifier, so a single `"` in the input would corrupt the DDL —
 * we reject before reaching SQL.
 */
export function assertSafeIdentifier(value: string, kind: string = 'identifier'): void {
  if (typeof value !== 'string' || !SAFE_IDENT.test(value) || !isCanonicalForm(value)) {
    emitIsthmusEvent('guard.tenant_identifier', {
      metadata: { kind, value: String(value).slice(0, 64) },
    })
    throw new Error(
      `Refusing to use unsafe ${kind} "${value}" in DDL. ` +
        `Tenant ids must match /^[a-zA-Z0-9_-]{1,63}$/ in canonical (NFKC) form (UUID v4 satisfies this).`
    )
  }
}

export function isUuidV4(value: string): boolean {
  return typeof value === 'string' && UUID_V4.test(value)
}

/**
 * Non-throwing twin of {@link assertSafeIdentifier}. Use it at attribution
 * seams (Redis metric keys, rate-limit buckets, log context) where a resolved
 * tenant id must never carry a `:` delimiter or any other character that could
 * inject key structure, but where the safe response is to drop/degrade rather
 * than throw. Accepts the same set as the drivers require: UUID v4 and opaque
 * alphanumeric host ids up to 63 chars; rejects the `:` used as a key separator.
 */
export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENT.test(value) && isCanonicalForm(value)
}

export { UUID_V4, SAFE_IDENT }

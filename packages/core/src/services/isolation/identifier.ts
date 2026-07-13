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
 * NFKC folds compatibility/homoglyph characters onto ASCII (`℀` becomes `a/c`,
 * `𝔸` becomes `A`, fullwidth digits become ASCII digits). The correct posture for a tenant identifier
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
 * This module is a pure, zero-import leaf: the identifier POLICY (the regexes,
 * the NFKC rule) and its predicates, nothing more. The observable guard — the
 * throw that refuses an unsafe id and the Isthmus emit that audits it — lives
 * one layer up in `isthmus/guarded_identifier.ts`, so the dependency arrow
 * points from the guard down to this policy, never the reverse. Interpolation
 * sites import the throwing `assertSafeIdentifier` from there; this leaf stays
 * importable from anywhere (including a bare unit runner) with no side effects.
 */

export function isUuidV4(value: string): boolean {
  return typeof value === 'string' && UUID_V4.test(value)
}

/**
 * Whether `value` is a safe identifier: a string matching the strict policy
 * ({@link SAFE_IDENT}) in canonical (NFKC) form. Accepts the set the drivers
 * require — UUID v4 and opaque alphanumeric host ids up to 63 chars — and
 * rejects anything carrying a `:` key separator, a quote, or a homoglyph.
 *
 * This is the pure predicate. At an attribution seam (Redis metric keys,
 * rate-limit buckets) where the safe response is to drop/degrade rather than
 * throw AND a rejection must be audited, use `guardedSafeIdentifier` from
 * `isthmus/guarded_identifier.ts` instead, which emits on the reject path.
 */
export function isSafeIdentifier(value: unknown): value is string {
  return typeof value === 'string' && SAFE_IDENT.test(value) && isCanonicalForm(value)
}

export { UUID_V4, SAFE_IDENT }

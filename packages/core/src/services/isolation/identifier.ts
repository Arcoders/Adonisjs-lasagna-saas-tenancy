const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * Strict identifier policy: alphanumerics, underscores, and hyphens only.
 * Length ≤ 63 to fit PostgreSQL's `NAMEDATALEN - 1`. Both UUID v4 (canonical
 * tenant id format) and short opaque ids that the host app may use satisfy
 * this regex.
 */
const SAFE_IDENT = /^[a-zA-Z0-9_-]{1,63}$/

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
  if (typeof value !== 'string' || !SAFE_IDENT.test(value)) {
    throw new Error(
      `Refusing to use unsafe ${kind} "${value}" in DDL. ` +
        `Tenant ids must match /^[a-zA-Z0-9_-]{1,63}$/ (UUID v4 satisfies this).`
    )
  }
}

export function isUuidV4(value: string): boolean {
  return typeof value === 'string' && UUID_V4.test(value)
}

export { UUID_V4, SAFE_IDENT }

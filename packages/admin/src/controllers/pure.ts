import { DateTime } from 'luxon'

/**
 * Pure, container-free helpers shared by the admin controllers. They live in
 * their own module (with no import of the core barrel) so they can be unit
 * tested directly: importing a controller would pull in
 * `@adonisjs/core/services/app` and the package barrel, which top-level-await
 * `app.booted(...)` and throw outside an Ignitor. The controller handlers
 * themselves resolve services from the booted container, so they are exercised
 * by the integration tier; everything that does NOT need the container lives
 * here and is locked at the unit level.
 */

/**
 * Coerce `value` to a finite integer clamped to `[min, max]`, falling back to
 * `fallback` when it is not a finite number. Used for pagination inputs, where
 * an unbounded `page`/`limit` would let `?page=10000&limit=200` drive an
 * OFFSET-based DOS against Postgres.
 */
export function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

export function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

/** A parseable absolute URL of any scheme. */
export function looksLikeUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

/** An http(s) URL: the loose check used where the value is only echoed, never fetched. */
export function isHttpsUrl(v: unknown): v is string {
  if (typeof v !== 'string') return false
  try {
    const u = new URL(v)
    return u.protocol === 'https:' || u.protocol === 'http:'
  } catch {
    return false
  }
}

/**
 * Three-state pick for partial-update payloads:
 *   - when the field is absent (`undefined`), return `undefined` and the caller skips it
 *   - when the field is set to `null`, return `null` and the caller clears the column
 *   - when the field is set to a value, run the validator; throw `invalid_<key>` on
 *     failure so the controller can surface a 400 with a stable code
 */
export function pickIfDefined<T>(
  input: any,
  key: string,
  validator?: (v: unknown) => boolean
): T | null | undefined {
  if (input == null || input[key] === undefined) return undefined
  if (input[key] === null) return null
  if (validator && !validator(input[key])) {
    throw new Error(`invalid_${key}`)
  }
  return input[key] as T
}

/**
 * Parse an optional `expiresAt` request input. Returns `{ ok: true, value }`
 * with a `DateTime` (or `null` when the field is absent/empty, which clears
 * any stored expiry, consistent with how `config` is handled), or
 * `{ ok: false }` when the value is present but not a valid ISO timestamp.
 */
export function parseExpiresAt(raw: unknown): { ok: true; value: DateTime | null } | { ok: false } {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw !== 'string') return { ok: false }
  const dt = DateTime.fromISO(raw)
  if (!dt.isValid) return { ok: false }
  return { ok: true, value: dt }
}

/** Parse an optional ISO date filter; `undefined` for absent/empty/invalid input. */
export function parseDate(raw: unknown): Date | undefined {
  if (typeof raw !== 'string' || raw.length === 0) return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d
}

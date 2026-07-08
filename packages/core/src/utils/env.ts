/**
 * Whether NODE_ENV denotes production, using the SAME normalization AdonisJS
 * applies (`@adonisjs/application` treats both `prod` and `production` as
 * production). Security gates must not diverge from `app.inProduction`: a raw
 * `=== 'production'` check would silently stay open on a `NODE_ENV=prod`
 * deployment that the framework itself considers production.
 *
 * Kept as a plain env read (no app import) so resolver modules stay importable
 * from unit tests without a booted Ignitor.
 */
export function isProductionNodeEnv(): boolean {
  const env = (process.env.NODE_ENV ?? '').toLowerCase()
  return env === 'production' || env === 'prod'
}

/**
 * Read a boolean environment TOGGLE with a single, normalized parse. True only for a
 * canonical truthy value (`true` / `1` / `yes` / `on`, trimmed + case-insensitive);
 * everything else — unset, empty, `false`, or a value typo — is false.
 *
 * Centralizing the parse keeps a security/safety toggle from being scattered as raw
 * `process.env.X === 'true'` reads: a bare strict compare silently picks the safe
 * (false) branch on `TRUE`, a trailing space, or `1`, so an operator who INTENDED to
 * enable it is ignored invisibly. This honors the intent for those variants and makes
 * the toggle unit-testable, while never widening past clearly-affirmative values.
 */
export function readBooleanEnvFlag(name: string): boolean {
  const raw = (process.env[name] ?? '').trim().toLowerCase()
  return raw === 'true' || raw === '1' || raw === 'yes' || raw === 'on'
}

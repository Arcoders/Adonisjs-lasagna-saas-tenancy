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

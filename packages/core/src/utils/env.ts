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
 * Whether NODE_ENV denotes a recognized development or test environment, using
 * the SAME normalization AdonisJS applies (`@adonisjs/application` treats
 * `dev`/`develop`/`development` as development and `test`/`testing` as test).
 *
 * The resolution-safety gate fails CLOSED everywhere EXCEPT these known-safe
 * envs: an unrecognized value (`staging`, unset, a typo) is treated like
 * production for that gate, so an insecure resolution posture cannot boot there
 * on a warning alone. Same rationale as `isProductionNodeEnv` — kept as a plain
 * env read (no app import) so it stays usable from a bare unit runner. At boot
 * the provider passes `app.inDev || app.inTest` explicitly; this is the fallback.
 */
export function isDevOrTestNodeEnv(): boolean {
  const env = (process.env.NODE_ENV ?? '').toLowerCase()
  return (
    env === 'dev' ||
    env === 'develop' ||
    env === 'development' ||
    env === 'test' ||
    env === 'testing'
  )
}

/**
 * Read a SECURITY/SAFETY opt-in environment flag. True ONLY for the exact word
 * `true` (trimmed + case-insensitive, so `TRUE` / ` true ` count); `1`, `yes`, `on`,
 * `false`, a typo, empty, or unset are ALL false.
 *
 * Both callers gate a security EXEMPTION: the webhook SSRF loopback escape hatch
 * (`WEBHOOKS_ALLOW_LOOPBACK_TARGETS`, `webhook_service.ts`) and the live-key-in-dev
 * guard (`STRIPE_ALLOW_LIVE_IN_DEV`, `stripe_driver.ts`). Enabling one must be
 * a DELIBERATE, unambiguous act: a stray `1`/`yes`/`on` in the environment must never
 * open the exemption. Exact-`true` is the conservative rule a reviewer expects of a
 * security opt-in, and `security_webhook_ssrf_loopback_optin.spec.ts` pins it. (An
 * earlier revision widened this to any truthy value, silently loosening the SSRF
 * exemption; that regression is corrected here.)
 *
 * Centralizing the parse also keeps the flag from being scattered as raw
 * `process.env.X === 'true'` reads and makes it unit-testable. For a non-security
 * CONVENIENCE toggle where `1`/`yes` should also count, parse inline. This helper is
 * deliberately strict.
 */
export function readBooleanEnvFlag(name: string): boolean {
  return (process.env[name] ?? '').trim().toLowerCase() === 'true'
}

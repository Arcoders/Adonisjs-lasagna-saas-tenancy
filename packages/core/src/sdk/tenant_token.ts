import { createHash, createHmac, randomBytes } from 'node:crypto'

/**
 * Turn a tenant id into a stable, non-reversible correlation TOKEN that is safe
 * to place in a broadcast Isthmus event's metadata.
 *
 * Why this exists: the public `IsthmusGuardTripped` event is broadcast
 * process-wide and is subscribable by ANY plugin (`emitter.on(...)`, no host-only
 * gate). A guard that puts a FOREIGN tenant's raw id into `metadata` (the
 * ContextSeal's `requestResolvedId`, a scope-mismatch's `active`) would hand a
 * compromised or untrusted plugin listener a real cross-tenant identifier. The
 * precise ids belong server-side, in the typed exception the host catches and in
 * the tenant-scoped audit log, never in the fan-out.
 *
 * The token is `HMAC-SHA256(processKey, id)` truncated to a short hex tag. It is:
 *   - non-reversible: without `processKey` a listener cannot map a token back to
 *     an id, and tenant ids are high-entropy UUIDv4s so a listener cannot
 *     brute-force a guess either;
 *   - stable within the process: the same id always tokenizes to the same value,
 *     so an operator still SEES that the same foreign tenant recurs and can
 *     correlate the two sides of one confusion event, without learning WHICH
 *     tenant it is.
 *
 * `processKey` is derived from `APP_KEY` when present (so the mapping is stable
 * across a replica fleet and operators can correlate across processes), falling
 * back to a per-process random salt when `APP_KEY` is unset (bare unit runners, a
 * misconfigured boot). Reading `process.env.APP_KEY` is not a `getConfig()` read,
 * so this stays usable on the config-phase emit path where guards trip before the
 * app exists. Either way the raw id NEVER appears in the token, so this can only
 * fail closed (lose cross-process correlation), never leak.
 *
 * Exported from `/sdk` next to `createGuardAudit`: a satellite that emits a guard
 * event carrying a foreign tenant id in its metadata uses this the same way.
 */

const TOKEN_PREFIX = 'ttok_'
// 8 bytes of HMAC. Ample against correlation collisions across realistic tenant
// counts, and short enough to sit unobtrusively in a log line next to the id
// fields the host already logs.
const TOKEN_HEX_CHARS = 16

let cachedKey: Buffer | undefined

function processKey(): Buffer {
  if (cachedKey) return cachedKey
  const appKey = process.env.APP_KEY
  cachedKey = appKey
    ? createHash('sha256').update(`lasagna:isthmus:tenant-token:v1\0${appKey}`).digest()
    : randomBytes(32)
  return cachedKey
}

/** HMAC a tenant id into a `ttok_<hex>` correlation token. See the module doc. */
export function tokenizeTenantId(id: string): string {
  const mac = createHmac('sha256', processKey()).update(id).digest('hex')
  return `${TOKEN_PREFIX}${mac.slice(0, TOKEN_HEX_CHARS)}`
}

/** The token prefix, exported so specs and log parsers can recognise a token. */
export { TOKEN_PREFIX as TENANT_TOKEN_PREFIX }

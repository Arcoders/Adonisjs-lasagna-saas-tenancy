import CryptoException from '../exceptions/crypto_exception.js'
import type { CryptoLockOptions, CryptoOperationLock } from '../types/operation_lock.js'

/**
 * The per-tenant operation lock for crypto, the same discipline as backup's
 * `tenant_operation_lock.ts`: a Redis `SET key token NX PX ttl` mutex, a
 * compare-and-delete release, and a TTL backstop that auto-releases if a crashed
 * holder never reaches its `finally`. Provision and shred serialize on it so two
 * concurrent writers to one `(subject × category)` DEK cannot interleave.
 *
 * crypto's `src` never statically imports a Redis client (the eager `/services`
 * barrel footgun); this lazy-imports `@adonisjs/redis` only when the lock actually
 * runs, so a bare unit runner (where the import fails) simply degrades to no lock.
 *
 * It fails open when Redis is unreachable: the operation proceeds without
 * cross-process serialization and logs a warning. This is deliberate and safe. The
 * partial `UNIQUE (subject_id, category) WHERE shredded_at IS NULL` is the real
 * singularity guarantee (a racing provision is refused fail-closed at the DB), and
 * blocking every encrypt/shred because the coordination layer is down is worse than
 * a rare unserialised write the DB constraint already protects. The lock is
 * defense-in-depth that turns a hard conflict into clean serialization.
 */

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/** Auto-release backstop for a crashed holder. A provision/shred normally finishes in ms. */
const LOCK_TTL_MS = 60_000
/** Extend the TTL well before it lapses so a slow shred keeps the lock. */
const RENEW_EVERY_MS = LOCK_TTL_MS / 3
/** Max time a `serialize` caller waits for a contended lock before refusing `shred_in_progress`. */
const SERIALIZE_MAX_WAIT_MS = 5_000
/** Base backoff between `serialize` acquire attempts; grows and is jittered, capped below. */
const SERIALIZE_BACKOFF_BASE_MS = 25
/** Cap on a single backoff sleep so the wait stays responsive. */
const SERIALIZE_BACKOFF_CAP_MS = 250

/** Release only if we still own the lock (compare-and-delete). */
const RELEASE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"
/** Extend the TTL only if we still own the lock (compare-and-pexpire). */
const RENEW_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end"

/** The per-tenant lock key. Distinct namespace from backup's, so the families are independent. */
export function cryptoOperationLockKey(tenantId: string): string {
  return `lasagna:crypto-op-lock:${tenantId}`
}

/**
 * Run `fn` while holding the per-tenant crypto operation lock. Contention behaviour
 * is chosen per call via `options.onContention` (default `'fail-open'`):
 *
 * - `'fail-open'` (provision/encrypt): a second caller whose `SET NX` fails proceeds
 *   without the lock; the partial UNIQUE serialises the only mutation (the racing
 *   INSERT) regardless.
 * - `'serialize'` (shred): a second caller waits (bounded, jittered backoff) for the
 *   holder to release, then proceeds; if it cannot acquire within the window it is
 *   refused `shred_in_progress` (retriable), so the two-phase WORM audit never runs
 *   concurrently with itself.
 *
 * Redis-down degrades both modes to fail-open (logged): the DB partial UNIQUE and,
 * on the shred path, the authoritative `shredLive()` return are the backstops there.
 * The lock is released in a `finally`.
 */
export const withCryptoOperationLock: CryptoOperationLock = async (tenantId, fn, options) => {
  const serialize = options?.onContention === 'serialize'

  const redis = await lazyRedis()
  if (!redis) {
    const log = await lazyLogger()
    log?.warn(
      { tenantId },
      'crypto operation lock: Redis unavailable — proceeding WITHOUT cross-process serialization (the partial UNIQUE / authoritative shredLive is the fail-closed backstop)'
    )
    return fn()
  }

  const key = cryptoOperationLockKey(tenantId)
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`

  const acquired = serialize
    ? await acquireSerialize(redis, key, token)
    : await acquireFailOpen(redis, key, token)

  if (!acquired) {
    // fail-open (or a Redis error degraded serialize to fail-open): proceed without
    // the lock. The partial UNIQUE and the authoritative shredLive make an overlap safe.
    return fn()
  }

  const renew = setInterval(() => {
    void redis.eval(RENEW_LUA, 1, key, token, String(LOCK_TTL_MS)).catch(() => {})
  }, RENEW_EVERY_MS)
  if (typeof renew.unref === 'function') renew.unref()

  try {
    return await fn()
  } finally {
    clearInterval(renew)
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => {})
  }
}

/** The minimal Redis surface the lock uses (a `set`/`eval` client, lazily resolved). */
type RedisLike = {
  set(key: string, value: string, ...args: unknown[]): Promise<unknown>
  eval(script: string, numKeys: number, ...args: unknown[]): Promise<unknown>
}

/** One `SET NX` attempt. On contention or a Redis error, return false (caller proceeds unlocked). */
async function acquireFailOpen(redis: RedisLike, key: string, token: string): Promise<boolean> {
  try {
    return (await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK'
  } catch {
    // Redis reachable-but-erroring: degrade to no lock (fail-open, DB constraint holds).
    return false
  }
}

/**
 * Retry `SET NX` with jittered backoff until acquired or the wait window lapses; on a
 * timeout, refuse `shred_in_progress` (retriable). A Redis error degrades to fail-open
 * (return false) rather than blocking, matching the Redis-down policy.
 */
async function acquireSerialize(redis: RedisLike, key: string, token: string): Promise<boolean> {
  const deadline = Date.now() + SERIALIZE_MAX_WAIT_MS
  for (let attempt = 0; ; attempt++) {
    let res: unknown
    try {
      res = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')
    } catch {
      return false // Redis error: degrade fail-open (shredLive is the backstop).
    }
    if (res === 'OK') return true
    if (Date.now() >= deadline) {
      throw new CryptoException(
        'shred_in_progress',
        '[crypto] another shred/provision for this tenant is in progress; the operation lock could not be acquired within the wait window. Retry shortly (the operation is idempotent).'
      )
    }
    await sleep(backoffWithJitter(attempt))
  }
}

/** Exponential backoff, capped, with full jitter, so retriers do not thunder. */
function backoffWithJitter(attempt: number): number {
  const ceiling = Math.min(SERIALIZE_BACKOFF_BASE_MS * 2 ** attempt, SERIALIZE_BACKOFF_CAP_MS)
  return Math.floor(Math.random() * ceiling)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

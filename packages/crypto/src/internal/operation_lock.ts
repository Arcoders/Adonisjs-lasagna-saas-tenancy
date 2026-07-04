import type { CryptoOperationLock } from '../types/operation_lock.js'

/**
 * The per-tenant operation lock for crypto (I10, §6.6), the same discipline as
 * backup's `tenant_operation_lock.ts`: a Redis `SET key token NX PX ttl` mutex, a
 * compare-and-delete release, and a TTL backstop that auto-releases if a crashed
 * holder never reaches its `finally`. Provision and shred serialize on it so two
 * concurrent writers to one `(subject × category)` DEK cannot interleave (T12).
 *
 * crypto's `src` never statically imports a Redis client (the eager `/services`
 * barrel footgun); this lazy-imports `@adonisjs/redis` only when the lock actually
 * runs, so a bare unit runner (where the import fails) simply degrades to no lock.
 *
 * FAIL-OPEN when Redis is unreachable: the operation proceeds WITHOUT cross-process
 * serialization and logs a warning. This is deliberate and safe — the partial
 * `UNIQUE (subject_id, category) WHERE shredded_at IS NULL` is the REAL singularity
 * guarantee (a racing provision is refused fail-closed at the DB, I10), and blocking
 * every encrypt/shred because the coordination layer is down is worse than a rare
 * unserialised write the DB constraint already protects. The lock is defense-in-depth
 * that turns a hard conflict into clean serialization.
 */

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/** Auto-release backstop for a crashed holder. A provision/shred normally finishes in ms. */
const LOCK_TTL_MS = 60_000
/** Extend the TTL well before it lapses so a slow shred keeps the lock. */
const RENEW_EVERY_MS = LOCK_TTL_MS / 3

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
 * Run `fn` while holding the per-tenant crypto operation lock. A concurrent holder
 * makes this WAIT-FREE-degrade: rather than block, a second caller whose `SET NX`
 * fails proceeds without the lock (fail-open) — the partial UNIQUE serialises the
 * actual DEK mutation regardless. On Redis-down it also proceeds and logs. The lock
 * is released in a `finally`.
 */
export const withCryptoOperationLock: CryptoOperationLock = async (tenantId, fn) => {
  const redis = await lazyRedis()
  if (!redis) {
    const log = await lazyLogger()
    log?.warn(
      { tenantId },
      'crypto operation lock: Redis unavailable — proceeding WITHOUT cross-process serialization (the partial UNIQUE is the fail-closed backstop)'
    )
    return fn()
  }

  const key = cryptoOperationLockKey(tenantId)
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`

  let acquired = false
  try {
    acquired = (await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')) === 'OK'
  } catch {
    // Redis reachable-but-erroring: degrade to no lock (fail-open, DB constraint holds).
  }

  if (!acquired) {
    // Another holder (or a transient Redis error): proceed without the lock. The
    // partial UNIQUE + idempotent shred make an unserialised overlap safe.
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

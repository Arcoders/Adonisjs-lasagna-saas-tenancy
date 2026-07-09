import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/sdk'

/**
 * Per-tenant mutual exclusion for backup-family operations (backup, restore,
 * clone, import). Two of these running against the same tenant at once can
 * corrupt each other: a `pg_dump` that reads a schema mid-`pg_restore --clean`
 * captures a half-dropped state; two restores race on the same objects. This
 * serialises them.
 *
 * Implementation: a Redis lock (`SET key token NX PX ttl`). The first caller
 * wins; a concurrent second caller is rejected fast with
 * `TenantOperationLockedException` rather than queued, so an operator sees a
 * clear "already running" error instead of a silent overlap. A renewal timer
 * extends the TTL while a long backup runs, and the TTL itself is a backstop
 * that auto-releases the lock if a crashed command never reaches its `finally`.
 *
 * Postgres advisory locks were the alternative, but they are session-scoped and
 * these operations shell out to `pg_dump`/`pg_restore`/`psql` rather than doing
 * their work on one held SQL session, so a Redis lock is the right fit here (and
 * Redis is already a hard dependency of the package).
 *
 * Behaviour when Redis is unavailable is the caller's choice via `failClosed`:
 *  - fail-OPEN (default): the operation proceeds WITHOUT the lock. Right for the
 *    read-only `backup`: blocking every backup because the coordination layer is
 *    down is worse than a rare unserialised read. The degradation is logged.
 *  - fail-CLOSED: the operation is refused with
 *    `TenantOperationLockUnavailableException` (503). Right for the DESTRUCTIVE
 *    ops (restore / clone / import), where an unserialised overlap can corrupt a
 *    schema irreversibly — a clean refusal beats silent corruption.
 */

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

/** Auto-release backstop for a crashed holder. Backups normally finish in seconds. */
const LOCK_TTL_MS = 30 * 60 * 1000
/** Extend the TTL well before it lapses so a long-running op keeps the lock. */
const RENEW_EVERY_MS = LOCK_TTL_MS / 3

/** Release only if we still own the lock (compare-and-delete). */
const RELEASE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end"
/** Extend the TTL only if we still own the lock (compare-and-pexpire). */
const RENEW_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) else return 0 end"

export function tenantOperationLockKey(tenantId: string): string {
  return `lasagna:tenant-op-lock:${tenantId}`
}

/**
 * Thrown when a backup-family operation is requested for a tenant that already
 * has one in flight. Carries HTTP status 409 so an admin API layer can map it
 * directly to a Conflict response.
 */
export class TenantOperationLockedException extends Error {
  readonly code = 'E_TENANT_OPERATION_LOCKED'
  readonly status = 409
  readonly tenantId: string
  readonly operation: string

  constructor(tenantId: string, operation: string) {
    super(
      `A backup-family operation is already in progress for tenant ${tenantId} ` +
        `(requested: ${operation}). Retry once it completes.`
    )
    this.name = 'TenantOperationLockedException'
    this.tenantId = tenantId
    this.operation = operation
  }
}

/**
 * Thrown when a `failClosed` operation cannot acquire the lock because the Redis
 * coordination layer is unreachable. Destructive operations refuse to run
 * unserialised rather than risk corrupting a schema. Carries HTTP status 503 so
 * an admin API layer can map it to Service Unavailable.
 */
export class TenantOperationLockUnavailableException extends Error {
  readonly code = 'E_TENANT_OPERATION_LOCK_UNAVAILABLE'
  readonly status = 503
  readonly tenantId: string
  readonly operation: string

  constructor(tenantId: string, operation: string) {
    super(
      `Cannot acquire the operation lock for tenant ${tenantId} (requested: ${operation}): ` +
        `the Redis coordination layer is unreachable. This is a destructive operation and is ` +
        `configured to fail closed rather than run unserialised. Restore Redis and retry.`
    )
    this.name = 'TenantOperationLockUnavailableException'
    this.tenantId = tenantId
    this.operation = operation
  }
}

/** Options for {@link withTenantOperationLock}. */
export interface TenantOperationLockOptions {
  /**
   * When Redis is unreachable: `false` (default) proceeds WITHOUT the lock
   * (fail-open, right for read-only backup); `true` refuses with
   * {@link TenantOperationLockUnavailableException} (fail-closed, right for the
   * destructive restore / clone / import).
   */
  failClosed?: boolean
}

/**
 * Run `fn` while holding the per-tenant operation lock. Throws
 * `TenantOperationLockedException` if another holder has it; otherwise runs
 * `fn`, renews the lock for the duration, and releases it in a `finally`.
 */
export async function withTenantOperationLock<T>(
  tenantId: string,
  operation: string,
  fn: () => Promise<T>,
  options: TenantOperationLockOptions = {}
): Promise<T> {
  assertSafeIdentifier(tenantId, 'tenant id')

  const redis = await lazyRedis()
  if (!redis) {
    if (options.failClosed) {
      throw new TenantOperationLockUnavailableException(tenantId, operation)
    }
    const log = await lazyLogger()
    log?.warn(
      { tenantId, operation },
      'tenant operation lock: Redis unavailable — proceeding WITHOUT cross-process serialization'
    )
    return fn()
  }

  const key = tenantOperationLockKey(tenantId)
  const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`

  const acquired = await redis.set(key, token, 'PX', LOCK_TTL_MS, 'NX')
  if (acquired !== 'OK') {
    throw new TenantOperationLockedException(tenantId, operation)
  }

  const renew = setInterval(() => {
    void redis.eval(RENEW_LUA, 1, key, token, String(LOCK_TTL_MS)).catch(() => {})
  }, RENEW_EVERY_MS)
  // Don't keep the event loop (or the test process) alive just for the renewal.
  if (typeof renew.unref === 'function') renew.unref()

  try {
    return await fn()
  } finally {
    clearInterval(renew)
    await redis.eval(RELEASE_LUA, 1, key, token).catch(() => {})
  }
}

/**
 * Structural types for the host's ioredis connection (the `@adonisjs/redis`
 * `'redis'` binding), injected as a seam so no AI module value-imports ioredis or
 * the eager core `/services` barrel, and so a command typo is a compile error
 * instead of hiding behind `Promise<any>`.
 *
 * The three request-path Redis consumers use DISJOINT command slices, so rather than
 * one wide type that would force every test double to implement commands it never
 * calls, each seam is typed with only the slice it uses (interface segregation):
 * {@link AiRedisMemory} for the conversation-memory list ops, {@link AiRedisLock} for
 * the purge dedup lock, {@link AiRedisProbe} for the read-only doctor probe.
 * {@link AiRedisLike} is their union, the full surface the real binding provides.
 * ioredis's `Redis` (and the RedisManager that proxies to it) satisfies every slice
 * structurally; the signatures are deliberately the Promise-returning, callback-free
 * overloads the satellite issues.
 */

/**
 * The pipeline surface the memory append relies on: RPUSH + LTRIM + PEXPIRE chained,
 * then EXEC. ioredis's `ChainableCommander` satisfies it. `exec` RESOLVES (never
 * rejects) on a backend fault, surfacing per-command `[error, value]` tuples, which
 * is why the memory service inspects them by hand rather than trusting a throw.
 */
export interface AiRedisPipeline {
  rpush(key: string, ...values: string[]): AiRedisPipeline
  ltrim(key: string, start: number, stop: number): AiRedisPipeline
  pexpire(key: string, milliseconds: number): AiRedisPipeline
  exec(): Promise<Array<[Error | null, unknown]> | null>
}

/** The list + SCAN + pipeline + tombstone-SET slice the conversation memory uses. */
export interface AiRedisMemory {
  /** Read a session's memory turns (`LRANGE key 0 -1`). */
  lrange(key: string, start: number, stop: number): Promise<string[]>
  /** Read the tenant/user purge tombstones (`MGET`); a missing key reads as `null`. */
  mget(...keys: string[]): Promise<Array<string | null>>
  /** Open a pipeline for the atomic memory append (RPUSH + LTRIM + PEXPIRE). */
  pipeline(): AiRedisPipeline
  /** Delete session/tombstone keys; the purge reads the removed count. */
  del(...keys: string[]): Promise<number>
  /**
   * UNLINK (lazy delete). Optional because not every backend exposes it, so the
   * purge feature-detects it (`typeof redis.unlink === 'function'`) and falls back
   * to DEL.
   */
  unlink?(...keys: string[]): Promise<number>
  /** Cursor scan, always called as `SCAN cursor MATCH pattern COUNT n`. */
  scan(
    cursor: string | number,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number
  ): Promise<[cursor: string, elements: string[]]>
  /** SET a tombstone key with `PX ttl` (the erasure re-population guard). */
  set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null>
  /** Connection options; the prefix-aware purge reads `options.keyPrefix` off it. */
  options?: { keyPrefix?: unknown }
}

/** The `SET NX PX` / `DEL` slice the per-tenant purge dedup lock uses. */
export interface AiRedisLock {
  set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null>
  /** The lock ignores the removed count, so the return is left unconstrained. */
  del(key: string): Promise<unknown>
}

/** The `PING` + `options.keyPrefix` slice the read-only `ai_compliance` doctor probe uses. */
export interface AiRedisProbe {
  ping(): Promise<unknown>
  options?: { keyPrefix?: unknown }
}

/** The full host connection surface: every slice, satisfied by the real `'redis'` binding. */
export type AiRedisLike = AiRedisMemory & AiRedisLock & AiRedisProbe

/**
 * A minimal Map-backed ioredis double for the LIST + SCAN + pipeline + scalar
 * surface the ConversationMemoryService uses (rpush / ltrim / pexpire / lrange /
 * del / unlink / scan / set / mget). It models redis' inclusive, negative-index
 * range semantics and ioredis' resolve-not-reject pipeline-outage shape, so a
 * unit spec exercises the memory service's real code paths (atomic append,
 * bounded trim, degrade-on-outage, WS-AI-9 purge + tombstone) without a live
 * server.
 *
 * It also faithfully models ioredis' `keyPrefix` footgun (WS-AI-9 E2): every
 * key-taking command is prefixed EXCEPT a `SCAN MATCH` pattern, which ioredis
 * leaves raw. So a purge that does not prepend the prefix to its MATCH silently
 * matches nothing — the exact bug the memory service now guards against.
 */

export interface FakeRedisOptions {
  /** When true, every command throws / a pipeline exec resolves with error tuples (an outage). */
  down?: boolean
  /** Emulate an ioredis `keyPrefix` (default `''`): prefixes every key-taking op but NOT a SCAN MATCH. */
  keyPrefix?: string
}

/** Redis LRANGE/LTRIM semantics: inclusive stop, negative indices count from the end. */
function sliceRange(list: readonly string[], start: number, stop: number): string[] {
  const n = list.length
  let s = start < 0 ? n + start : start
  let e = stop < 0 ? n + stop : stop
  if (s < 0) s = 0
  if (e >= n) e = n - 1
  if (s > e || s >= n) return []
  return list.slice(s, e + 1)
}

/** Translate a redis glob (`*` / `?`) to an anchored RegExp; `:` and the rest are literal. */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

class FakePipeline {
  readonly #ops: Array<() => void> = []
  constructor(
    private readonly redis: FakeRedisLists,
    private readonly isDown: () => boolean,
    private readonly store: (key: string) => string
  ) {}

  rpush(key: string, value: string): this {
    this.#ops.push(() => {
      const k = this.store(key)
      const list = this.redis.data.get(k) ?? []
      list.push(value)
      this.redis.data.set(k, list)
    })
    return this
  }

  ltrim(key: string, start: number, stop: number): this {
    this.#ops.push(() => {
      const k = this.store(key)
      const list = this.redis.data.get(k) ?? []
      this.redis.data.set(k, sliceRange(list, start, stop))
    })
    return this
  }

  pexpire(key: string, ttlMs: number): this {
    // The fake has no wall clock; record the last TTL so a spec can assert it was set.
    this.#ops.push(() => this.redis.ttls.set(this.store(key), ttlMs))
    return this
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    // ioredis RESOLVES (never rejects) on a backend fault, surfacing per-command
    // [error, value] tuples — the shape the memory service's outage detection reads.
    if (this.isDown()) return this.#ops.map(() => [new Error('redis down'), null])
    return this.#ops.map((op) => {
      op()
      return [null, 'OK']
    })
  }
}

export class FakeRedisLists {
  readonly data = new Map<string, string[]>()
  readonly ttls = new Map<string, number>()
  /** Scalar keys (SET/GET/MGET), e.g. the WS-AI-9 purge tombstones — a separate space from the LIST keys. */
  readonly scalars = new Map<string, string>()
  /** ioredis exposes the configured prefix here; the memory service reads it to prefix a SCAN MATCH. */
  readonly options: { keyPrefix: string }
  #down: boolean

  constructor(opts: FakeRedisOptions = {}) {
    this.#down = opts.down ?? false
    this.options = { keyPrefix: opts.keyPrefix ?? '' }
  }

  setDown(down: boolean): void {
    this.#down = down
  }

  /** The stored form of a key: ioredis prepends `keyPrefix` to every key-taking command. */
  #k(key: string): string {
    return this.options.keyPrefix + key
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.#down) throw new Error('redis down')
    return sliceRange(this.data.get(this.#k(key)) ?? [], start, stop)
  }

  async del(...keys: string[]): Promise<number> {
    if (this.#down) throw new Error('redis down')
    let deleted = 0
    for (const key of keys) if (this.data.delete(this.#k(key))) deleted += 1
    return deleted
  }

  async unlink(...keys: string[]): Promise<number> {
    // UNLINK removes the same keys as DEL (non-blocking on a real server).
    return this.del(...keys)
  }

  async scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
    if (this.#down) throw new Error('redis down')
    const matchIdx = args.indexOf('MATCH')
    // ioredis does NOT apply keyPrefix to a SCAN MATCH: it is matched raw against
    // the (already-prefixed) stored keys. This is the E2 footgun the service handles.
    const pattern = matchIdx >= 0 ? String(args[matchIdx + 1]) : '*'
    const re = globToRegExp(pattern)
    const keys = [...this.data.keys()].filter((key) => re.test(key))
    // Single-pass: return every match and terminate the cursor.
    return ['0', keys]
  }

  /** SET key value [PX ttl] — the tombstone write path. Extra args (PX/ttl) are accepted and ignored by the fake. */
  async set(key: string, value: string, ..._args: unknown[]): Promise<'OK'> {
    if (this.#down) throw new Error('redis down')
    this.scalars.set(this.#k(key), String(value))
    return 'OK'
  }

  /** MGET — the tombstone read path. Missing keys read as `null`, like ioredis. */
  async mget(...keys: string[]): Promise<Array<string | null>> {
    if (this.#down) throw new Error('redis down')
    return keys.map((key) => this.scalars.get(this.#k(key)) ?? null)
  }

  pipeline(): FakePipeline {
    return new FakePipeline(
      this,
      () => this.#down,
      (key) => this.#k(key)
    )
  }
}

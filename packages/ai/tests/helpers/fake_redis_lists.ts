/**
 * A minimal Map-backed ioredis double for the LIST + SCAN + pipeline surface the
 * ConversationMemoryService uses (rpush / ltrim / pexpire / lrange / del / scan).
 * It models redis' inclusive, negative-index range semantics and ioredis'
 * resolve-not-reject pipeline-outage shape, so a unit spec exercises the memory
 * service's real code paths (atomic append, bounded trim, degrade-on-outage)
 * without a live server.
 */

export interface FakeRedisOptions {
  /** When true, every command throws / a pipeline exec resolves with error tuples (an outage). */
  down?: boolean
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
    private readonly isDown: () => boolean
  ) {}

  rpush(key: string, value: string): this {
    this.#ops.push(() => {
      const list = this.redis.data.get(key) ?? []
      list.push(value)
      this.redis.data.set(key, list)
    })
    return this
  }

  ltrim(key: string, start: number, stop: number): this {
    this.#ops.push(() => {
      const list = this.redis.data.get(key) ?? []
      this.redis.data.set(key, sliceRange(list, start, stop))
    })
    return this
  }

  pexpire(key: string, ttlMs: number): this {
    // The fake has no wall clock; record the last TTL so a spec can assert it was set.
    this.#ops.push(() => this.redis.ttls.set(key, ttlMs))
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
  #down: boolean

  constructor(opts: FakeRedisOptions = {}) {
    this.#down = opts.down ?? false
  }

  setDown(down: boolean): void {
    this.#down = down
  }

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    if (this.#down) throw new Error('redis down')
    return sliceRange(this.data.get(key) ?? [], start, stop)
  }

  async del(...keys: string[]): Promise<number> {
    if (this.#down) throw new Error('redis down')
    let deleted = 0
    for (const key of keys) if (this.data.delete(key)) deleted += 1
    return deleted
  }

  async scan(cursor: string, ...args: unknown[]): Promise<[string, string[]]> {
    if (this.#down) throw new Error('redis down')
    const matchIdx = args.indexOf('MATCH')
    const pattern = matchIdx >= 0 ? String(args[matchIdx + 1]) : '*'
    const re = globToRegExp(pattern)
    const keys = [...this.data.keys()].filter((key) => re.test(key))
    // Single-pass: return every match and terminate the cursor.
    return ['0', keys]
  }

  pipeline(): FakePipeline {
    return new FakePipeline(this, () => this.#down)
  }
}

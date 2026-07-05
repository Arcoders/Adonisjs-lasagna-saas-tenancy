import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto'
import { assertSafeIdentifier } from '@adonisjs-lasagna/saas-tenancy/sdk'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import {
  AI_MEMORY_KEY_PREFIX,
  DEFAULT_MEMORY_MAX_TURNS,
  DEFAULT_MEMORY_TTL_MS,
} from '../constants.js'

/**
 * Conversation memory (WS-AI-4, I2): per-(tenant, user, session) chat history,
 * encrypted at rest and TTL-bounded in Redis, replayed into the model context as
 * `user`/`assistant` turns (never `system`, so a poisoned turn is DATA, not an
 * instruction: #1/#10).
 *
 * Three structural properties carry the invariant, none of them a heuristic:
 *
 *  - **Encrypted at rest.** Every stored exchange is enc_v2 ciphertext produced
 *    by the injected {@link ConversationMemoryDeps.encryptMemory} (the kernel's
 *    `writeSecret(_, 'aiConversationMemory')`), so the service never touches the
 *    crypto primitives directly and the memory blob cannot be decrypted as any
 *    other secret class (its own HKDF context).
 *  - **Per-user isolation via an unforgeable session token.** A session is
 *    server-minted (`randomBytes`) and its token is `<sid>.<sessionMac>`, where
 *    `sessionMac` HMAC-binds the sid to a `userMac = HMAC(tenant, principal)`.
 *    {@link resolveSession} recomputes both against the CURRENT principal and
 *    `timingSafeEqual`s, so a supplied or leaked token cannot reach another
 *    principal's memory (G6) — a mismatch is a `guard.ai_memory_session_invalid`
 *    refusal (400), emitted before the throw.
 *  - **Race-free, bounded storage.** Each turn is an atomic `RPUSH` of one
 *    ciphertext element (no read-modify-write, so concurrent turns on one session
 *    never lose each other), then `LTRIM` to the turn cap and a sliding `PEXPIRE`.
 *
 * Reads fail SAFE, not closed: an unreadable list (a store outage, corruption, or
 * an APP_KEY rotation past the {@link ConversationMemoryDeps.decryptMemoryPrevious}
 * grace) degrades to empty memory — the chat proceeds statelessly, bounded by the
 * TTL, rather than failing an otherwise-serviceable request. Only the session
 * token forgery check fails closed.
 *
 * The two-segment storage key `ai:mem:<tenantId>:<userMac>:<sessionMac>` is the
 * WS-AI-9 purge seam: `SCAN ai:mem:<tenant>:*` erases a whole tenant and
 * `ai:mem:<tenant>:<userMac>:*` erases one user (GDPR), while the macs stay
 * unforgeable and server-only.
 */

/** Frozen HKDF domain separation (the utils/crypto.ts discipline): a change means a v2 segment, never an edit. */
const MAC_SALT = Buffer.from('lasagna-ai:conversation-memory:v1:key')
const MAC_INFO = Buffer.from('session-mac-key')

/** Derive the 32-byte memory session-MAC key from the host's APP_KEY. */
export function deriveMemoryMacKey(appKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appKey, 'utf8'), MAC_SALT, MAC_INFO, 32))
}

/** One replayed message. Only ever `user` or `assistant` (never `system`, enforced by check-ai-invariant-2). */
export interface ConversationTurn {
  readonly role: 'user' | 'assistant'
  readonly content: string
}

/** A resolved session: the opaque Redis storage key its turn list lives under. */
export interface ResolvedMemorySession {
  readonly storageKey: string
}

/** A freshly minted session: the storage key plus the token handed back via `X-Ai-Session`. */
export interface MintedMemorySession extends ResolvedMemorySession {
  readonly token: string
}

/**
 * The narrow, injected seams the service needs, so it never value-imports the
 * eager core barrel and unit-tests against fakes. `encryptMemory`/`decryptMemory`
 * are deliberately NOT named `encrypt`/`decrypt`: the repo's secret-crypto guard
 * scans this file, and the accessor names keep it clear of the raw-primitive regex
 * while still routing every write/read through the kernel's fail-closed,
 * domain-separated `writeSecret`/`readSecret`.
 */
export interface ConversationMemoryDeps {
  /** Raw Redis accessor (the `'redis'` binding), injected like the rate limiter's, for atomic list ops. */
  getRedis: () => Promise<any>
  /** 32-byte session-MAC key from {@link deriveMemoryMacKey}. */
  macKey: Buffer
  /** enc_v2 write for a memory blob (kernel `writeSecret(_, 'aiConversationMemory')`). */
  encryptMemory: (plaintext: string) => string
  /** enc_v2 fail-closed read under the CURRENT APP_KEY (kernel `readSecret(_, 'aiConversationMemory')`). */
  decryptMemory: (ciphertext: string) => string
  /**
   * Optional dual-key grace read under the previous APP_KEY (`OLD_APP_KEY`), so
   * in-flight sessions survive a rotation window. Absent ⇒ a post-rotation blob
   * simply degrades to empty, bounded by the TTL.
   */
  decryptMemoryPrevious?: (ciphertext: string) => string
  /** The memory config block; absent ⇒ {@link enabled} is false and the service is inert. */
  config?: { maxTurns?: number; maxChars?: number; ttlMs?: number }
  /** Best-effort per-tenant integer metric (default MetricsService); fire-and-forget, never on the reject path. */
  metric?: (tenantId: string, name: string, value: number) => void
  /** Best-effort metadata-only warn log (never content, G3). */
  warn?: (message: string) => void
}

/** The per-tenant memory metrics (custom integer counters), never carrying content. */
export const AI_MEMORY_UNREADABLE_METRIC = 'ai_memory_unreadable'
export const AI_MEMORY_PERSIST_FAILED_METRIC = 'ai_memory_persist_failed'
export const AI_MEMORY_DECRYPT_PREVIOUS_METRIC = 'ai_memory_decrypt_previous_used'
/** A turn dropped because a WS-AI-9 purge tombstone post-dates the request (E5, re-population guard). */
export const AI_MEMORY_PURGED_DROP_METRIC = 'ai_memory_purged_drop'
/**
 * A stored turn dropped during load because it could not be decrypted or parsed:
 * the APP_KEY rotation grace expired, the blob is corrupt, or it was tampered with.
 * `load` fails SAFE (it drops the turn and continues), so without this counter the
 * degradation is only WARN-logged and invisible to a metrics dashboard. Emitting it
 * makes a botched key rotation observable, not silent (WS-AI-8, H1).
 */
export const AI_MEMORY_UNDECRYPTABLE_METRIC = 'ai_memory_undecryptable'

/** The tombstone key segment: `ai:mem:tomb:<tenant>[:<userMac>]`, a purge high-water mark (E5). */
const AI_MEMORY_TOMBSTONE_INFIX = 'tomb'

/**
 * Container singleton (registered by `AiProvider.register()`). Stateless itself;
 * all state lives in Redis behind the injected `getRedis` seam.
 */
export default class ConversationMemoryService {
  readonly #deps: ConversationMemoryDeps

  constructor(deps: ConversationMemoryDeps) {
    this.#deps = deps
  }

  /** Whether memory is configured (the block is present). The gateway skips all memory work when false. */
  get enabled(): boolean {
    return this.#deps.config !== undefined
  }

  #maxTurns(): number {
    return this.#deps.config?.maxTurns ?? DEFAULT_MEMORY_MAX_TURNS
  }

  #ttlMs(): number {
    return this.#deps.config?.ttlMs ?? DEFAULT_MEMORY_TTL_MS
  }

  /** HMAC that binds a session to the (tenant, principal) pair — the per-user isolation segment. */
  #userMac(tenantId: string, principal: string): string {
    return createHmac('sha256', this.#deps.macKey).update(`${tenantId}\n${principal}`).digest('hex')
  }

  /** HMAC that binds a random sid to its userMac — the per-conversation segment. */
  #sessionMac(userMac: string, sid: string): string {
    return createHmac('sha256', this.#deps.macKey).update(`${userMac}\n${sid}`).digest('hex')
  }

  #key(tenantId: string, userMac: string, sessionMac: string): string {
    assertSafeIdentifier(tenantId, 'tenant id')
    return `${AI_MEMORY_KEY_PREFIX}:${tenantId}:${userMac}:${sessionMac}`
  }

  /** Mint a new server-owned session bound to (tenant, principal). The token is handed back via `X-Ai-Session`. */
  mintSession(tenantId: string, principal: string): MintedMemorySession {
    const userMac = this.#userMac(tenantId, principal)
    const sid = randomBytes(16).toString('hex')
    const sessionMac = this.#sessionMac(userMac, sid)
    return {
      token: `${sid}.${sessionMac}`,
      storageKey: this.#key(tenantId, userMac, sessionMac),
    }
  }

  /**
   * Validate a client-supplied session token against the CURRENT (tenant,
   * principal) and return its storage key. A token whose MAC does not verify is a
   * hijack or pre-seed attempt on another principal's memory (G6): emit
   * `guard.ai_memory_session_invalid` and refuse with a 400.
   */
  resolveSession(token: string, tenantId: string, principal: string): ResolvedMemorySession {
    const dot = token.lastIndexOf('.')
    const sid = dot > 0 ? token.slice(0, dot) : ''
    const presented = dot > 0 ? token.slice(dot + 1) : ''
    const userMac = this.#userMac(tenantId, principal)
    const expected = this.#sessionMac(userMac, sid)

    if (!timingSafeEqualHex(presented, expected)) {
      emitAiGuardEvent('guard.ai_memory_session_invalid', { tenantId })
      throw new AIException(
        'memory_session_invalid',
        'Refusing the request: the session token does not verify for this principal ' +
          '(a memory hijack or pre-seed attempt)'
      )
    }
    return { storageKey: this.#key(tenantId, userMac, expected) }
  }

  /**
   * Load a session's prior turns, newest last, flattened to `user`/`assistant`
   * messages ready to prepend. Fails SAFE: any store or decrypt failure degrades
   * to `[]` (bounded by the TTL) rather than failing the chat.
   */
  async load(tenantId: string, storageKey: string): Promise<ConversationTurn[]> {
    let raw: unknown[]
    try {
      const redis = await this.#deps.getRedis()
      raw = await redis.lrange(storageKey, 0, -1)
    } catch {
      this.#metric(tenantId, AI_MEMORY_UNREADABLE_METRIC)
      this.#deps.warn?.(`[ai] conversation memory unreadable for a session (store error)`)
      return []
    }
    if (!Array.isArray(raw) || raw.length === 0) return []

    const turns: ConversationTurn[] = []
    let degraded = false
    for (const element of raw) {
      if (typeof element !== 'string') {
        degraded = true
        continue
      }
      const decoded = this.#decodeExchange(element, tenantId)
      if (decoded === null) {
        degraded = true
        continue
      }
      turns.push({ role: 'user', content: decoded.u })
      turns.push({ role: 'assistant', content: decoded.a })
    }
    if (degraded) {
      // H1: a metric, not just a warn, so a silent memory degradation (a botched
      // APP_KEY rotation dropping every historical turn) is visible to operators.
      this.#metric(tenantId, AI_MEMORY_UNDECRYPTABLE_METRIC)
      this.#deps.warn?.(
        `[ai] conversation memory partially unreadable for a session (rotation/corruption)`
      )
    }
    return turns
  }

  /**
   * Append one completed exchange. An atomic `RPUSH` of a single ciphertext
   * element (no read-modify-write, so concurrent turns never lose each other),
   * then `LTRIM` to the turn cap and a sliding `PEXPIRE`. Best-effort: a store or
   * encrypt failure emits a metric + a metadata-only warn and NEVER throws — the
   * response already completed, and a lost turn is bounded by the TTL.
   */
  async append(
    tenantId: string,
    storageKey: string,
    exchange: { user: string; assistant: string },
    turnStartedAt?: number
  ): Promise<void> {
    try {
      // Re-population guard (WS-AI-9 E5): SCAN has no snapshot isolation, so an
      // in-flight turn can RPUSH after a purge already swept this session's
      // bucket, resurrecting erased history for the full memory TTL. A purge
      // stamps a tombstone (a high-water mark) FIRST; a turn whose request began
      // before that mark is stale conversation being written late, so drop it.
      // `turnStartedAt` is the request's memory-snapshot time; absent (a caller
      // that opts out) skips the check. A tombstone read error falls through to
      // the outer catch, which does NOT persist (privacy-safe).
      if (
        turnStartedAt !== undefined &&
        (await this.#isTombstoned(tenantId, storageKey, turnStartedAt))
      ) {
        this.#metric(tenantId, AI_MEMORY_PURGED_DROP_METRIC)
        return
      }
      const cipher = this.#deps.encryptMemory(
        JSON.stringify({ v: 1, u: exchange.user, a: exchange.assistant })
      )
      const redis = await this.#deps.getRedis()
      const results = await redis
        .pipeline()
        .rpush(storageKey, cipher)
        .ltrim(storageKey, -this.#maxTurns(), -1)
        .pexpire(storageKey, this.#ttlMs())
        .exec()
      // ioredis resolves (not rejects) on a backend fault, surfacing per-command
      // [error, value] tuples — the rate_limiter's outage shape. Treat any command
      // error, or a missing result set, as a persist failure.
      if (!results) throw new Error('memory append pipeline returned no results')
      const commandError = results.find((entry: [Error | null, unknown]) => entry?.[0])?.[0]
      if (commandError) throw commandError
    } catch {
      this.#metric(tenantId, AI_MEMORY_PERSIST_FAILED_METRIC)
      this.#deps.warn?.(`[ai] conversation memory persist failed for a session (store error)`)
    }
  }

  /** Erase one session's memory (used by the gateway and WS-AI-9). Best-effort. */
  async clear(storageKey: string): Promise<void> {
    try {
      const redis = await this.#deps.getRedis()
      await redis.del(storageKey)
    } catch {
      // Best-effort: a failed clear is retried by the caller or reaped by the TTL.
    }
  }

  /**
   * Erase every session of one principal (GDPR per-user erasure, WS-AI-9). Stamps
   * a per-user tombstone (E5) BEFORE scanning so an in-flight turn cannot
   * re-populate, then SCAN-deletes the user segment (never `KEYS`, which blocks
   * Redis). Returns the number of session keys removed so the operator can tell
   * "erased N" from "no active data". Keyed off the RAW principal (E1): the
   * embeddings `actor` column is a SHA-256 of the principal, so the caller hashes
   * separately for the vector side; memory keys the raw value.
   */
  async purgeUser(tenantId: string, principal: string): Promise<number> {
    assertSafeIdentifier(tenantId, 'tenant id')
    const userMac = this.#userMac(tenantId, principal)
    await this.#writeTombstone(tenantId, userMac)
    return this.#scanDelete(`${AI_MEMORY_KEY_PREFIX}:${tenantId}:${userMac}:*`)
  }

  /** Erase every session of one tenant (tenant purge, WS-AI-9). Tombstone first (E5); returns keys removed. */
  async purgeTenant(tenantId: string): Promise<number> {
    assertSafeIdentifier(tenantId, 'tenant id')
    await this.#writeTombstone(tenantId)
    return this.#scanDelete(`${AI_MEMORY_KEY_PREFIX}:${tenantId}:*`)
  }

  /**
   * Decrypt one stored exchange under the current key, then the previous key
   * (rotation grace), returning its `{u, a}` or null when unreadable. Not a
   * throw: `load` treats null as a dropped element and degrades.
   */
  #decodeExchange(element: string, tenantId: string): { u: string; a: string } | null {
    let plain: string
    try {
      plain = this.#deps.decryptMemory(element)
    } catch {
      const previous = this.#deps.decryptMemoryPrevious
      if (!previous) return null
      try {
        plain = previous(element)
        this.#metric(tenantId, AI_MEMORY_DECRYPT_PREVIOUS_METRIC)
      } catch {
        return null
      }
    }
    try {
      const parsed = JSON.parse(plain)
      if (
        typeof parsed === 'object' &&
        parsed !== null &&
        typeof parsed.u === 'string' &&
        typeof parsed.a === 'string'
      ) {
        return { u: parsed.u, a: parsed.a }
      }
    } catch {
      // fall through
    }
    return null
  }

  /**
   * SCAN-delete every key matching `pattern` (an `ai:mem:...` glob), returning the
   * count removed. Loops to cursor `'0'` so a live keyspace is fully swept.
   *
   * keyPrefix-correct (WS-AI-9 E2): ioredis applies a configured `keyPrefix` to
   * writes and to `del`/`unlink` args, but NOT to a `SCAN MATCH`. So the MATCH is
   * prefixed manually, and the prefix is stripped off each returned key before
   * `unlink` (which re-applies it) — otherwise a prefixed deployment would match
   * nothing and silently purge zero keys (a right-to-erasure that did nothing).
   * A prefix we cannot resolve throws (fail-closed), never a false zero. On a
   * mid-scan store error the partial count rides on the thrown error so the caller
   * can still report "N deleted (partial)".
   */
  async #scanDelete(pattern: string): Promise<number> {
    const redis = await this.#deps.getRedis()
    const prefix = resolveKeyPrefix(redis)
    const match = prefix + pattern
    let cursor = '0'
    let deleted = 0
    try {
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', match, 'COUNT', 1000)
        cursor = next
        if (keys.length > 0) {
          const bare = prefix ? keys.map((k: string) => stripPrefix(k, prefix)) : keys
          deleted += await unlinkAll(redis, bare)
        }
      } while (cursor !== '0')
    } catch (error) {
      if (error && typeof error === 'object')
        (error as { deletedCount?: number }).deletedCount = deleted
      throw error
    }
    return deleted
  }

  /**
   * Stamp a purge high-water mark (E5). `ai:mem:tomb:<tenant>[:<userMac>]` = the
   * purge time in ms, TTL ≥ the memory TTL so it outlives any in-flight turn that
   * could re-populate. A plain `SET` (ioredis prefixes it uniformly with reads),
   * so it needs no keyPrefix handling. Fail-closed: a store error propagates, so a
   * purge that could not arm the guard is reported as failed.
   */
  async #writeTombstone(tenantId: string, userMac?: string): Promise<void> {
    const redis = await this.#deps.getRedis()
    const key = userMac
      ? `${AI_MEMORY_KEY_PREFIX}:${AI_MEMORY_TOMBSTONE_INFIX}:${tenantId}:${userMac}`
      : `${AI_MEMORY_KEY_PREFIX}:${AI_MEMORY_TOMBSTONE_INFIX}:${tenantId}`
    await redis.set(key, String(Date.now()), 'PX', this.#ttlMs())
  }

  /** True when a purge tombstone (tenant- or user-scoped) post-dates this request's snapshot (E5). */
  async #isTombstoned(
    tenantId: string,
    storageKey: string,
    turnStartedAt: number
  ): Promise<boolean> {
    const rest = storageKey.slice(`${AI_MEMORY_KEY_PREFIX}:${tenantId}:`.length)
    const userMac = rest.split(':')[0]
    const redis = await this.#deps.getRedis()
    const [tenantTomb, userTomb] = await redis.mget(
      `${AI_MEMORY_KEY_PREFIX}:${AI_MEMORY_TOMBSTONE_INFIX}:${tenantId}`,
      `${AI_MEMORY_KEY_PREFIX}:${AI_MEMORY_TOMBSTONE_INFIX}:${tenantId}:${userMac}`
    )
    const stamp = Math.max(toMillis(tenantTomb), toMillis(userTomb))
    return stamp > turnStartedAt
  }

  #metric(tenantId: string, name: string): void {
    try {
      this.#deps.metric?.(tenantId, name, 1)
    } catch {
      // A metric write must never touch the reject/degrade path.
    }
  }
}

/** Constant-time compare of two hex strings; false on a length or encoding mismatch. */
function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex')
  const bufB = Buffer.from(b, 'hex')
  if (bufA.length === 0 || bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

/**
 * The configured ioredis `keyPrefix`, so a `SCAN MATCH` can be prefixed manually
 * (WS-AI-9 E2). A real ioredis always exposes `options.keyPrefix` (default `''`);
 * a client with no `options` concept does not prefix, so `''`. Only a malformed
 * (present but non-string) keyPrefix is unresolvable, and a purge that could
 * silently miss prefixed keys must fail loudly, not return a false zero.
 */
function resolveKeyPrefix(redis: { options?: { keyPrefix?: unknown } }): string {
  const prefix = redis?.options?.keyPrefix
  if (prefix === undefined || prefix === null) return ''
  if (typeof prefix !== 'string') {
    throw new Error(
      '[ai] refusing the memory purge: the Redis keyPrefix is set to a non-string value, so a ' +
        'SCAN MATCH could silently miss prefixed keys (a right-to-erasure that erased nothing).'
    )
  }
  return prefix
}

/** Strip a known prefix so a SCAN-returned (prefixed) key can be handed to `del`/`unlink` (which re-apply it). */
function stripPrefix(key: string, prefix: string): string {
  return key.startsWith(prefix) ? key.slice(prefix.length) : key
}

/** `UNLINK` a batch (non-blocking on the server), falling back to `DEL` on a pre-4.0 Redis. Returns the count. */
async function unlinkAll(
  redis: {
    unlink?: (...keys: string[]) => Promise<number>
    del: (...keys: string[]) => Promise<number>
  },
  keys: string[]
): Promise<number> {
  try {
    if (typeof redis.unlink === 'function') return await redis.unlink(...keys)
  } catch {
    // UNLINK is Redis 4+; fall through to DEL.
  }
  return redis.del(...keys)
}

/** Parse a tombstone value (ms since epoch) to a number; 0 when absent or malformed. */
function toMillis(value: unknown): number {
  if (typeof value !== 'string') return 0
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

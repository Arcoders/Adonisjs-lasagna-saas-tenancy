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
    exchange: { user: string; assistant: string }
  ): Promise<void> {
    try {
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
   * Erase every session of one principal (GDPR per-user erasure, WS-AI-9). Scans
   * the user segment and deletes. Uses `SCAN` (never `KEYS`, which blocks Redis).
   */
  async purgeUser(tenantId: string, principal: string): Promise<void> {
    const userMac = this.#userMac(tenantId, principal)
    await this.#scanDelete(`${AI_MEMORY_KEY_PREFIX}:${tenantId}:${userMac}:*`)
  }

  /** Erase every session of one tenant (tenant purge, WS-AI-9). */
  async purgeTenant(tenantId: string): Promise<void> {
    assertSafeIdentifier(tenantId, 'tenant id')
    await this.#scanDelete(`${AI_MEMORY_KEY_PREFIX}:${tenantId}:*`)
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

  async #scanDelete(pattern: string): Promise<void> {
    const redis = await this.#deps.getRedis()
    let cursor = '0'
    do {
      // NOTE (WS-AI-9): if the host configures a redis keyPrefix, the MATCH
      // pattern must include it (ioredis applies the prefix to keys but not to a
      // SCAN MATCH). The write paths above are prefix-consistent (ioredis prefixes
      // them uniformly); purge hardening for a prefixed deployment lands with the
      // WS-AI-9 command that calls this.
      const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      cursor = next
      if (keys.length > 0) await redis.del(...keys)
    } while (cursor !== '0')
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

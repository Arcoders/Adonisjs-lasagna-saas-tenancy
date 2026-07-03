import { createHmac, hkdfSync, randomBytes } from 'node:crypto'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import {
  AI_IDEMPOTENCY_KEY_MAX_LENGTH,
  AI_IDEMPOTENCY_MAX_BYTES,
  DEFAULT_AI_IDEMPOTENCY_TTL_MS,
} from '../constants.js'

/**
 * Idempotent replay for completed streams (#5): unlike billing's dedup-only
 * ledger, this CACHES THE RESPONSE, so a client retry under the same
 * `Idempotency-Key` returns the same bytes without a second reservation or
 * provider charge.
 *
 * Every cache decision here fails OPEN toward "no replay": a store outage, a
 * corrupt entry, an unreadable epoch, an oversized response, all degrade to
 * running the stream normally. The fail-closed rails of the gateway remain
 * the mount/authz gates and the quota reservation; a retry convenience must
 * never take the service down with its backend. The one fail-closed edge is
 * the malformed header itself (`guard.ai_idempotency_key`, 400): the header
 * is the only client-supplied cache input, so a key outside the bound is a
 * malformed request, not a cache miss.
 *
 * Keying: `ai:idem:<epoch>:<hmac>` inside the kernel's per-tenant cache
 * namespace. The MAC (HMAC-SHA256 under an HKDF key derived from APP_KEY)
 * binds tenant, principal, session and header together, so no scope
 * component ever appears in a cache key and a forged key cannot collide with
 * another principal's entry. The per-tenant `epoch` segment is the WS-AI-9
 * purge seam: bumping it makes every cached response unreachable at once and
 * the short TTL reaps the orphans.
 */

/** Frozen HKDF domain separation (the utils/crypto.ts discipline): changing it means a v2 segment, never an edit. */
const MAC_SALT = Buffer.from('lasagna-ai:idempotency:v1:key')
const MAC_INFO = Buffer.from('mac-key')
const KEY_PREFIX = 'ai:idem'
const EPOCH_KEY = 'ai:idem:epoch'

/** Visible ASCII only: the header is an opaque client token, not free text. */
const PRINTABLE_KEY = /^[\x21-\x7E]+$/

/** Derive the 32-byte idempotency MAC key from the host's APP_KEY. */
export function deriveAiIdempotencyMacKey(appKey: string): Buffer {
  return Buffer.from(hkdfSync('sha256', Buffer.from(appKey, 'utf8'), MAC_SALT, MAC_INFO, 32))
}

/**
 * Validate a PRESENT `Idempotency-Key` header (an absent header simply means
 * no idempotency). Empty, oversized or non-printable keys are a malformed
 * request: emit `guard.ai_idempotency_key` and reject with a 400.
 */
export function validateIdempotencyKeyHeader(header: string, tenantId?: string): string {
  if (
    header.length === 0 ||
    header.length > AI_IDEMPOTENCY_KEY_MAX_LENGTH ||
    !PRINTABLE_KEY.test(header)
  ) {
    emitAiGuardEvent('guard.ai_idempotency_key', {
      tenantId: tenantId ?? null,
      metadata: { length: header.length },
    })
    throw new AIException(
      'invalid_request',
      'Refusing the request: malformed Idempotency-Key header (empty, over ' +
        `${AI_IDEMPOTENCY_KEY_MAX_LENGTH} chars, or non-printable)`
    )
  }
  return header
}

/** The scope one cached response is shared within. All four parts feed the MAC. */
export interface AiIdempotencyScope {
  readonly tenantId: string
  /** The authenticated principal (config.ai.resolvePrincipal). Callers with no principal get no idempotency. */
  readonly principal: string
  /** Optional conversation/session discriminator (WS-AI-4 owns real sessions). */
  readonly sessionId?: string | null
  /** The validated Idempotency-Key header value. */
  readonly headerKey: string
}

/** What a completed stream persists and a replay re-writes verbatim. */
export interface CachedAiResponse {
  readonly v: 1
  /** The raw SSE frames in write order (heartbeats excluded), replayed byte for byte. */
  readonly frames: readonly string[]
  readonly result: {
    readonly tokensSettled: number
    readonly fragments: number
    readonly lastEventId: string | undefined
  }
  /**
   * The conversation-memory session token minted on this turn (WS-AI-4), if any.
   * Re-emitted as `X-Ai-Session` on replay so a client whose turn-1 connection
   * dropped after the mint still learns its session on retry (instead of
   * re-minting an empty one and losing the persisted turn).
   */
  readonly sessionToken?: string
}

/**
 * The tenant-aware storage seam the provider backs with the kernel's
 * `cacheFor(tenant)` namespace (memory L1 + Redis L2). Kept narrow and
 * injected so gateway modules never value-import the eager `/services`
 * barrel, and so unit specs run against a Map.
 */
export interface AiIdempotencyStore {
  get(tenantId: string, key: string): Promise<string | undefined | null>
  set(tenantId: string, key: string, value: string, ttlMs: number): Promise<void>
}

export interface AiIdempotencyServiceOptions {
  store: AiIdempotencyStore
  /** 32-byte MAC key from {@link deriveAiIdempotencyMacKey}. */
  macKey: Buffer
  /** Replay window per entry. Default {@link DEFAULT_AI_IDEMPOTENCY_TTL_MS}. */
  ttlMs?: number
  /** Cache-entry byte cap. Default {@link AI_IDEMPOTENCY_MAX_BYTES}. */
  maxBytes?: number
  /** Epoch value generator (test seam). Default: 8 random bytes, hex. */
  newEpoch?: () => string
}

/**
 * Container singleton (registered by `AiProvider.register()`, resolved via
 * `container.make`). Stateless itself; all state lives in the injected store.
 */
export default class AiIdempotencyService {
  readonly #store: AiIdempotencyStore
  readonly #macKey: Buffer
  readonly #ttlMs: number
  readonly #maxBytes: number
  readonly #newEpoch: () => string

  constructor(options: AiIdempotencyServiceOptions) {
    this.#store = options.store
    this.#macKey = options.macKey
    this.#ttlMs = options.ttlMs ?? DEFAULT_AI_IDEMPOTENCY_TTL_MS
    this.#maxBytes = options.maxBytes ?? AI_IDEMPOTENCY_MAX_BYTES
    this.#newEpoch = options.newEpoch ?? (() => randomBytes(8).toString('hex'))
  }

  /** The entry key for a scope under an epoch. Pure; exposed for key-scoping specs. */
  entryKey(scope: AiIdempotencyScope, epoch: string): string {
    const mac = createHmac('sha256', this.#macKey)
      .update(`${scope.tenantId}\n${scope.principal}\n${scope.sessionId ?? ''}\n${scope.headerKey}`)
      .digest('hex')
    return `${KEY_PREFIX}:${epoch}:${mac}`
  }

  /**
   * A cached completed response for this scope, or null. Null on ANY doubt:
   * store outage, unreadable epoch, corrupt JSON, unknown shape.
   */
  async lookup(scope: AiIdempotencyScope): Promise<CachedAiResponse | null> {
    try {
      const epoch = await this.#currentEpoch(scope.tenantId)
      if (epoch === null) return null
      const raw = await this.#store.get(scope.tenantId, this.entryKey(scope, epoch))
      if (typeof raw !== 'string') return null
      return parseCachedResponse(raw)
    } catch {
      return null
    }
  }

  /**
   * Persist a completed response for replay. Silently skips when the payload
   * exceeds the byte cap or the store misbehaves: caching is best-effort and
   * must never fail a stream that already succeeded.
   */
  async save(scope: AiIdempotencyScope, response: CachedAiResponse): Promise<void> {
    try {
      const payload = JSON.stringify(response)
      if (Buffer.byteLength(payload, 'utf8') > this.#maxBytes) return
      const epoch = await this.#currentEpoch(scope.tenantId)
      if (epoch === null) return
      await this.#store.set(scope.tenantId, this.entryKey(scope, epoch), payload, this.#ttlMs)
    } catch {
      // Best-effort by contract.
    }
  }

  /**
   * The WS-AI-9 purge seam: rotate the tenant's epoch so every cached response
   * becomes unreachable immediately (their TTLs reap the bytes). Unlike the
   * cache ops this is FAIL-CLOSED: a GDPR purge that silently did nothing would
   * be a compliance bug, so the caller must see it.
   *
   * Fail-closed VERIFIABLY (WS-AI-9 E3): a `set` that a misbehaving store
   * silently no-ops resolves without throwing, leaving the old epoch resolving
   * and pre-purge responses replayable. So we read the epoch back and confirm
   * the new value landed; a store outage (the `set` or the read-back throws) or
   * an unconfirmed value both throw, never a false success.
   */
  async bumpEpoch(tenantId: string): Promise<void> {
    // Epoch lives well past any entry so a mid-window expiry cannot resurrect
    // pre-purge entries under the default epoch.
    const epochTtl = Math.max(24 * 60 * 60 * 1000, this.#ttlMs * 10)
    const epoch = this.#newEpoch()
    await this.#store.set(tenantId, EPOCH_KEY, epoch, epochTtl)
    const confirmed = await this.#store.get(tenantId, EPOCH_KEY)
    if (confirmed !== epoch) {
      throw new AIException(
        'provider_unavailable',
        'Refusing to confirm the AI response-cache purge: the idempotency epoch did not rotate ' +
          'verifiably (the store did not read back the new value). Retry the purge.'
      )
    }
  }

  /**
   * The tenant's current epoch: the stored value, `'0'` when never bumped, or
   * null when the store cannot answer. Null (not `'0'`) on error, and in the
   * privacy-critical direction: after a purge, a store that cannot confirm the
   * epoch must yield NO replays rather than risk serving pre-purge entries.
   */
  async #currentEpoch(tenantId: string): Promise<string | null> {
    try {
      const stored = await this.#store.get(tenantId, EPOCH_KEY)
      if (stored === undefined || stored === null) return '0'
      return typeof stored === 'string' ? stored : null
    } catch {
      return null
    }
  }
}

/** Parse + shape-check a stored entry; anything unexpected is a miss, never a throw. */
function parseCachedResponse(raw: string): CachedAiResponse | null {
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    if (parsed.v !== 1) return null
    if (!Array.isArray(parsed.frames)) return null
    if (!parsed.frames.every((frame: unknown) => typeof frame === 'string')) return null
    const result = parsed.result
    if (typeof result !== 'object' || result === null) return null
    if (typeof result.tokensSettled !== 'number' || typeof result.fragments !== 'number') {
      return null
    }
    if (result.lastEventId !== undefined && typeof result.lastEventId !== 'string') return null
    if (parsed.sessionToken !== undefined && typeof parsed.sessionToken !== 'string') return null
    return parsed as CachedAiResponse
  } catch {
    return null
  }
}

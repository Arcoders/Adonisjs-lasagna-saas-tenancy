import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { getConfig } from '../config.js'
import type AuditLogService from './audit_log_service.js'
import type {
  ImpersonationContext,
  ImpersonationSession,
  ImpersonationStartOptions,
  ImpersonationStartResult,
} from '../types/impersonation.js'

const NAMESPACE = 'impersonation'
const DEFAULT_DURATION = 15 * 60
const MAX_DURATION = 24 * 60 * 60
/**
 * Permissive enough to accept UUIDs, ULIDs, and bigint-as-string user ids
 * but strict enough to keep the audit trail readable and reject embedded
 * control chars or path-like values. Apps with looser id formats can pass
 * `validateTargetUserId: false` (added if/when needed) — for now we err on
 * the side of safety.
 */
const TARGET_USER_ID_RE = /^[a-zA-Z0-9._:@-]{1,128}$/

/**
 * Stateless impersonation service. Issues short-lived tokens that bind an
 * admin actor to a target tenant user. Tokens are wire-encoded as
 * `<sessionId>.<hmac>` so verification is two cheap operations: an HMAC
 * compare (rejects tampering offline) and a cache lookup (confirms the
 * session is still alive and not revoked).
 *
 * The package never assumes anything about the host's auth model — it just
 * exposes the verified `ImpersonationContext`. Wiring it into `auth.user`
 * is the responsibility of the consumer.
 */
export default class ImpersonationService {
  #auditLog?: AuditLogService

  constructor(opts?: { auditLog?: AuditLogService }) {
    this.#auditLog = opts?.auditLog
  }

  /**
   * Start an impersonation session. Returns a wire token, the underlying
   * session id, and the absolute expiration. The session is persisted in
   * the package cache (BentoCache → Redis L2) with TTL = duration.
   */
  async start(opts: ImpersonationStartOptions): Promise<ImpersonationStartResult> {
    // Validate the secret BEFORE we touch the cache or generate session
    // data. Otherwise a misconfigured deploy leaves us hanging on Redis
    // long enough for the request to time out — and it would be a real
    // pain to debug from a 30-second timeout instead of a clear error.
    this.#secret()

    if (!TARGET_USER_ID_RE.test(opts.targetUserId)) {
      throw new Error(
        `ImpersonationService: targetUserId "${opts.targetUserId}" does not match ` +
          `/^[a-zA-Z0-9._:@-]{1,128}$/. Pass a clean opaque id, not a path or arbitrary string.`
      )
    }
    if (!TARGET_USER_ID_RE.test(opts.adminId)) {
      throw new Error(
        `ImpersonationService: adminId "${opts.adminId}" does not match ` +
          `/^[a-zA-Z0-9._:@-]{1,128}$/.`
      )
    }
    const cfg = getConfig().impersonation
    const requested = opts.durationSeconds ?? cfg?.defaultDuration ?? DEFAULT_DURATION
    const max = cfg?.maxDuration ?? MAX_DURATION
    const duration = Math.min(Math.max(requested, 60), max)

    const sessionId = randomBytes(16).toString('hex')
    const startedAt = new Date().toISOString()
    const expiresAt = Date.now() + duration * 1000

    const session: ImpersonationSession = {
      id: sessionId,
      tenantId: opts.tenantId,
      targetUserId: opts.targetUserId,
      adminId: opts.adminId,
      adminType: opts.adminType ?? 'admin',
      reason: opts.reason ?? null,
      startedAt,
      expiresAt,
      ipAddress: opts.ipAddress ?? null,
    }

    const ns = await this.#cacheNamespace()
    await ns.set({
      key: sessionId,
      value: session,
      ttl: duration * 1000,
    })

    await this.#audit({
      tenantId: opts.tenantId,
      actorId: opts.adminId,
      actorType: session.adminType,
      action: 'admin:impersonate:start',
      ipAddress: opts.ipAddress ?? null,
      metadata: {
        sessionId,
        targetUserId: opts.targetUserId,
        durationSeconds: duration,
        reason: opts.reason ?? null,
      },
    })

    return {
      token: this.#sign(sessionId),
      sessionId,
      expiresAt,
    }
  }

  /** Revoke a session by token (idempotent — silent if already gone). */
  async stop(token: string, opts: { ipAddress?: string | null } = {}): Promise<boolean> {
    const sessionId = this.#extractSessionId(token)
    if (!sessionId) return false

    const ns = await this.#cacheNamespace()
    const session = (await ns.get({ key: sessionId })) as ImpersonationSession | undefined
    if (!session) return false

    await ns.delete({ key: sessionId })

    await this.#audit({
      tenantId: session.tenantId,
      actorId: session.adminId,
      actorType: session.adminType,
      action: 'admin:impersonate:stop',
      ipAddress: opts.ipAddress ?? null,
      metadata: {
        sessionId: session.id,
        targetUserId: session.targetUserId,
      },
    })

    return true
  }

  /** Revoke by raw session id (admin tooling). */
  async revokeById(sessionId: string): Promise<boolean> {
    const ns = await this.#cacheNamespace()
    const existed = (await ns.get({ key: sessionId })) !== undefined
    if (!existed) return false
    await ns.delete({ key: sessionId })
    return true
  }

  /**
   * Verify a token: HMAC check, cache lookup, expiration check. Returns the
   * derived public context or `null` for any failure mode (tampering,
   * expiration, revocation, malformed token).
   */
  async verify(token: string): Promise<ImpersonationContext | null> {
    const sessionId = this.#extractSessionId(token)
    if (!sessionId) return null

    const ns = await this.#cacheNamespace()
    const session = (await ns.get({ key: sessionId })) as ImpersonationSession | undefined
    if (!session) return null
    if (session.expiresAt <= Date.now()) {
      // Cache TTL should beat us to it, but guard anyway.
      await ns.delete({ key: sessionId })
      return null
    }

    // Audit the FIRST successful verify so the trail records when the
    // session was actually used (start vs use can be hours apart). Subsequent
    // verifies are silent — we only need one entry per session.
    if (!session.firstVerifyAt) {
      const remainingMs = Math.max(session.expiresAt - Date.now(), 1000)
      session.firstVerifyAt = new Date().toISOString()
      try {
        await ns.set({ key: sessionId, value: session, ttl: remainingMs })
        await this.#audit({
          tenantId: session.tenantId,
          actorId: session.adminId,
          actorType: session.adminType,
          action: 'admin:impersonate:first-use',
          ipAddress: session.ipAddress,
          metadata: {
            sessionId: session.id,
            targetUserId: session.targetUserId,
            firstVerifyAt: session.firstVerifyAt,
          },
        })
      } catch {
        // Audit / cache write failures must not break verify — the session
        // is still valid; we just lose the first-use audit row.
      }
    }

    return {
      sessionId: session.id,
      tenantId: session.tenantId,
      userId: session.targetUserId,
      adminId: session.adminId,
      adminType: session.adminType,
      startedAt: session.startedAt,
    }
  }

  /** Encode `<sessionId>.<hmac>` using the configured secret. */
  #sign(sessionId: string): string {
    const sig = createHmac('sha256', this.#secret()).update(sessionId).digest('hex')
    return `${sessionId}.${sig}`
  }

  /** Returns the session id if the signature is valid, else null. */
  #extractSessionId(token: string): string | null {
    if (typeof token !== 'string' || token.length < 33) return null
    const dot = token.indexOf('.')
    if (dot <= 0 || dot === token.length - 1) return null
    const sessionId = token.slice(0, dot)
    const presented = token.slice(dot + 1)
    const expected = createHmac('sha256', this.#secret()).update(sessionId).digest('hex')
    const a = Buffer.from(presented, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length || a.length === 0) return null
    if (!timingSafeEqual(a, b)) return null
    return sessionId
  }

  #secret(): string {
    const secret = getConfig().impersonation?.secret
    if (!secret || secret.length < 32) {
      throw new Error(
        'multitenancy.impersonation.secret is not configured or is shorter than 32 characters. ' +
          'Set it to a long random string before issuing impersonation tokens.'
      )
    }
    return secret
  }

  async #cacheNamespace() {
    const { getCache } = await import('../utils/cache.js')
    return getCache().namespace(NAMESPACE)
  }

  async #audit(opts: {
    tenantId: string
    actorId: string
    actorType: 'admin' | 'system'
    action: string
    ipAddress: string | null
    metadata: Record<string, unknown>
  }): Promise<void> {
    if (!this.#auditLog) return
    try {
      await this.#auditLog.log(opts)
    } catch {
      // Audit failures should not bring down impersonation; the operator
      // already has the wire token in hand.
    }
  }
}

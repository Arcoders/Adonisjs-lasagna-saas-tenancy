/**
 * Persistent state of an active impersonation session. Stored under a
 * randomly generated session id; the wire token combines that id with an
 * HMAC signature so the cache lookup can be cheap and the signature check
 * can reject tampering without a round-trip.
 */
export interface ImpersonationSession {
  /** Random session id (uuid v4-style hex), also the cache key. */
  id: string
  /** Tenant whose user is being impersonated. */
  tenantId: string
  /** Target user id inside the tenant context. */
  targetUserId: string
  /** Acting admin id (free-form — opaque to the package). */
  adminId: string
  /** Logical type of the actor. Default `admin`. */
  adminType: 'admin' | 'system'
  /** Optional human-readable reason. Recorded in the audit log. */
  reason: string | null
  /** ISO timestamp when the session began. */
  startedAt: string
  /** Epoch-ms when the session expires. */
  expiresAt: number
  /** Optional source IP recorded for the audit trail. */
  ipAddress: string | null
  /**
   * Set on the first successful `verify()` call. Lets the service emit a
   * single `admin:impersonate:first-use` audit entry without spamming the
   * log on every subsequent request in the session.
   */
  firstVerifyAt?: string | null
}

/** Public context derived from a verified impersonation token. */
export interface ImpersonationContext {
  sessionId: string
  tenantId: string
  userId: string
  adminId: string
  adminType: 'admin' | 'system'
  startedAt: string
}

export interface ImpersonationStartOptions {
  tenantId: string
  targetUserId: string
  adminId: string
  adminType?: 'admin' | 'system'
  reason?: string | null
  durationSeconds?: number
  ipAddress?: string | null
}

export interface ImpersonationStartResult {
  /** Wire token to hand to the impersonating user (URL / cookie / header). */
  token: string
  /** Session id, useful for revocation by id and audit linking. */
  sessionId: string
  /** Epoch-ms expiration. */
  expiresAt: number
}

declare module '@adonisjs/core/http' {
  interface HttpContext {
    /**
     * Set by `ImpersonationMiddleware` when a valid token is presented.
     * Consumer auth code can use it to override the effective user.
     */
    impersonation?: ImpersonationContext
  }
}

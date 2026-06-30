import { tenancy } from '../tenancy.js'
import type { LogOptions } from '../services/audit_log_service.js'

/** The audit action recorded for every tenant-scope bypass. */
export const SCOPE_BYPASS_ACTION = 'scope:bypass'

// In-process fixed-window rate limit so a burst of bypasses (a loop calling
// unscoped() per tenant) cannot flood the audit log. Deliberately NOT
// Redis-backed: auditing a bypass must never depend on, or fail closed on, Redis.
// A per-process cap is enough to bound volume; the window resets lazily.
const WINDOW_MS = 10_000
const MAX_PER_WINDOW = 50
let windowStart = 0
let countInWindow = 0
let suppressedInWindow = 0

/**
 * Whether a bypass audit should be emitted now, under the fixed-window cap.
 * Pure-ish (takes `now`) so the limiter is unit-testable without faking time.
 */
export function allowScopeBypassAudit(now: number): boolean {
  if (now - windowStart >= WINDOW_MS) {
    windowStart = now
    countInWindow = 0
    suppressedInWindow = 0
  }
  if (countInWindow >= MAX_PER_WINDOW) {
    suppressedInWindow++
    return false
  }
  countInWindow++
  return true
}

/** Test seam: reset the in-process limiter so a spec starts from a clean window. */
export function __resetScopeBypassAuditRateLimit(): void {
  windowStart = 0
  countInWindow = 0
  suppressedInWindow = 0
}

/**
 * The audit entry for a scope bypass. Single-sources the action + metadata shape
 * so the emit path and its tests never drift. The `reason` is the caller's
 * attribution (`unscoped(fn, { reason })`); the tenant context is whatever was
 * active when the bypass opened.
 */
export function scopeBypassEntry(reason: string | undefined, tenantId: string | null): LogOptions {
  return {
    action: SCOPE_BYPASS_ACTION,
    tenantId,
    actorType: 'system',
    metadata: { reason: reason ?? null },
  }
}

function currentTenantIdSafe(): string | null {
  try {
    return tenancy.currentId() ?? null
  } catch {
    return null
  }
}

/**
 * Best-effort, rate-limited emission of a scope-bypass audit event. Never throws
 * and only does a single audit write: auditing a bypass must not be able to break
 * a legitimate cross-tenant operation. The audit service is resolved lazily, so
 * an unbooted context (a unit test) simply records nothing.
 */
export async function recordScopeBypass(reason?: string): Promise<void> {
  try {
    if (!allowScopeBypassAudit(Date.now())) return
    const { default: app } = await import('@adonisjs/core/services/app')
    const { default: AuditLogService } = await import('../services/audit_log_service.js')
    const audit = await app.container.make(AuditLogService)
    await audit.log(scopeBypassEntry(reason, currentTenantIdSafe()))
  } catch {
    // Auditing must never break a legitimate bypass.
  }
}

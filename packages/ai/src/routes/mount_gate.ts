import type { AiConfig } from '../define_config.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'

/**
 * One middleware entry, in any of the shapes Adonis' `group.use(...)` accepts
 * at runtime: a registered middleware name, a middleware function, or a
 * named-middleware reference (the `middleware.tenantGuard()` shape, which
 * carries a `handle` method). Mirrors the reporting satellite's union.
 */
export type AiMiddlewareEntry =
  | string
  | ((...args: any[]) => any)
  | { name?: string; handle: (...args: any[]) => any }

/** The middleware chain a host attaches to the AI routes: one entry or an array. */
export type AiRouteMiddleware = AiMiddlewareEntry | AiMiddlewareEntry[]

export interface MultitenancyAiRoutesOptions {
  /** Mount prefix for the AI routes. Default `/ai`. */
  prefix?: string
  /**
   * Middleware applied to every AI route: the host's chain, TenantGuard first
   * (so `request.tenant()` is resolved and lifecycle-checked) then its auth
   * middleware (so the principal exists for `authorizeAIAccess` and
   * idempotency).
   *
   * REQUIRED, with NO public opt-out: unlike the reporting dashboard there is
   * no legitimate unauthenticated mount for tenant-scoped, cost-bearing AI
   * routes, so `false` is not an accepted value and an effectively-absent
   * chain (undefined, null, '', or the dangerous empty array) refuses to
   * mount.
   */
  middleware: AiRouteMiddleware
}

/**
 * True when the middleware chain is effectively absent: undefined, null, an
 * empty string, or the dangerous EMPTY ARRAY (which `group.use` would accept
 * and silently guard nothing). Pure, so the G4 matrix unit-tests without the
 * router service.
 */
export function isAbsentAiMiddleware(middleware: unknown): boolean {
  if (middleware === undefined || middleware === null) return true
  if (middleware === '') return true
  if (Array.isArray(middleware) && middleware.length === 0) return true
  return false
}

/**
 * The shared no-membership-gate risk text (the kernel's `membershipGateRisk`
 * pattern): one wording for the mount-time warning and the `ai_membership_gate`
 * doctor check, so both speak with one voice. Null when the posture is safe.
 */
export function aiMembershipGateRisk(ai: AiConfig | undefined): string | null {
  if (!ai) return null
  if (typeof ai.authorizeAIAccess === 'function') return null
  if (ai.acknowledgeNoMembershipGate === true) {
    return (
      'multitenancy/ai: config.ai.acknowledgeNoMembershipGate is true, so the AI routes mount ' +
      'WITHOUT a membership gate. Every authenticated principal of a tenant can stream (and ' +
      'spend) on its behalf; the host middleware chain is the only access control. Wire ' +
      'config.ai.authorizeAIAccess to scope access per principal.'
    )
  }
  return (
    'multitenancy/ai: config.ai.authorizeAIAccess is not set and acknowledgeNoMembershipGate ' +
    'is not true. AI routes are default-deny (G4) and refuse to mount in this posture.'
  )
}

/**
 * The fail-closed mount gate (G4). Every refusal emits `guard.ai_route_mount`
 * before it throws, so a deploy that dies here still leaves an audit trace
 * (counted; usually a no_emitter drop, since the app has not booted). Returns
 * the acknowledged-posture warning for the caller to log when mounting is
 * allowed without a hook.
 */
export function assertAiMountAllowed(
  options: MultitenancyAiRoutesOptions,
  ai: AiConfig | undefined
): { warning?: string | undefined } {
  if (isAbsentAiMiddleware(options.middleware)) {
    emitAiGuardEvent('guard.ai_route_mount', { metadata: { reason: 'middleware_missing' } })
    throw new Error(
      'multitenancyAiRoutes: Refusing to mount AI routes without a middleware chain. Pass ' +
        'your TenantGuard + auth middleware, e.g. multitenancyAiRoutes({ middleware: ' +
        '[middleware.tenantGuard(), middleware.auth()] }). There is no public opt-out: AI ' +
        'routes are tenant-scoped and cost-bearing.'
    )
  }

  if (!ai) {
    emitAiGuardEvent('guard.ai_route_mount', { metadata: { reason: 'config_missing' } })
    throw new Error(
      'multitenancyAiRoutes: Refusing to mount AI routes: config.ai is absent. Declare the ' +
        'ai block in config/multitenancy.ts (allowedProviders, provider blocks, ' +
        'authorizeAIAccess) before mounting.'
    )
  }

  if (typeof ai.authorizeAIAccess !== 'function' && ai.acknowledgeNoMembershipGate !== true) {
    emitAiGuardEvent('guard.ai_route_mount', { metadata: { reason: 'no_membership_gate' } })
    throw new Error(
      'multitenancyAiRoutes: Refusing to mount AI routes without a membership gate (G4). ' +
        'Set config.ai.authorizeAIAccess (false/throw => 403), or acknowledge the posture ' +
        'explicitly with config.ai.acknowledgeNoMembershipGate = true if the host middleware ' +
        'chain already scopes access per principal.'
    )
  }

  if (typeof ai.authorizeAIAccess !== 'function') {
    return { warning: aiMembershipGateRisk(ai) ?? undefined }
  }
  return {}
}

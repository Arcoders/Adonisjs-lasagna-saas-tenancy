import type { HttpContext } from '@adonisjs/core/http'

/**
 * Resolver for the acting admin's id, wired by `multitenancyAdminRoutes(...)`.
 *
 * This is the ONLY trusted source of the acting admin identity. The package
 * never reads an `adminId` from the request body, since that would let any
 * caller forge the audit trail. Returning `null` denies: impersonation refuses
 * to mint a token, while a config mutation still records an audit row with a
 * null actor (a mutation must always leave evidence, even when attribution is
 * unavailable).
 *
 * Kept in its own tiny module (no controller, no container imports) so the
 * satellite controllers and the audit helper can read it without pulling in
 * `admin_controller.js`, whose dependency graph eagerly touches
 * `@adonisjs/core/services/app` and would break pure unit tests.
 */
export type AdminActorResolver = (ctx: HttpContext) => string | null | Promise<string | null>

let adminActorResolver: AdminActorResolver | null = null

/** Wire the resolver. Called once from `multitenancyAdminRoutes`. */
export function setAdminActorResolver(fn: AdminActorResolver | null): void {
  adminActorResolver = fn
}

/** The currently wired resolver, or `null` when the host did not supply one. */
export function getAdminActorResolver(): AdminActorResolver | null {
  return adminActorResolver
}

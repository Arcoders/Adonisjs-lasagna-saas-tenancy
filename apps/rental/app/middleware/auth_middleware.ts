import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { Authenticators } from '@adonisjs/auth/types'

/**
 * Authenticates the request against the given guards (`backoffice` for operator
 * routes, `tenant` for tenant-staff routes) before the handler runs. An
 * unauthenticated request raises E_UNAUTHORIZED_ACCESS, which renders as 401.
 *
 * On tenant routes this shares the per-request guard instance with the
 * membership gate's `auth.use('tenant').check()`, so a request pays exactly one
 * token lookup even though both layers run.
 */
export default class AuthMiddleware {
  async handle(
    ctx: HttpContext,
    next: NextFn,
    options: { guards?: (keyof Authenticators)[] } = {}
  ) {
    await ctx.auth.authenticateUsing(options.guards)
    return next()
  }
}

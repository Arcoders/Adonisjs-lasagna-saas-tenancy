import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import env from '#start/env'

/**
 * Header-based fake auth used to gate `multitenancyAdminRoutes`.
 *
 * Real apps should swap this for session/JWT/mTLS — the package doesn't
 * prescribe one. This stub exists so the demo can ship with the admin
 * routes mounted but still locked down.
 */
export default class DemoAdminAuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    const provided = ctx.request.header('x-admin-token')
    const expected = env.get('DEMO_ADMIN_TOKEN')
    if (!provided || provided !== expected) {
      return ctx.response.unauthorized({
        error: { code: 'ADMIN_AUTH_REQUIRED', message: 'Missing or invalid x-admin-token header' },
      })
    }
    return next()
  }
}

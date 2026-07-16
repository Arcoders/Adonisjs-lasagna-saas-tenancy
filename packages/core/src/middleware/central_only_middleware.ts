import { resolveTenant } from '../extensions/request.js'
import CentralRouteViolationException from '../exceptions/central_route_violation_exception.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/**
 * Central-only routes: reject the request if a tenant resolver matches.
 * Useful for signup, marketing, admin pages that must NOT be reachable
 * from a tenant subdomain or path.
 */
export default class CentralOnlyMiddleware {
  async handle({ request }: HttpContext, next: NextFn) {
    const result = await resolveTenant(request)
    if (result !== undefined) {
      throw new CentralRouteViolationException()
    }
    return next()
  }
}

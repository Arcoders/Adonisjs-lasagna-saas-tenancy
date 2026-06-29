import { Exception } from '@adonisjs/core/exceptions'

/**
 * Exception thrown when a route restricted to the central domain is reached from a tenant context, extending the AdonisJS base Exception. It carries a 404 HTTP status, the error code E_CENTRAL_ROUTE_VIOLATION, and a default message stating the route is only available on the central domain.
 */
export default class CentralRouteViolationException extends Exception {
  static readonly status = 404
  static readonly code = 'E_CENTRAL_ROUTE_VIOLATION'
  static readonly message = 'This route is only available on the central domain'
}

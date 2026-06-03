import { Exception } from '@adonisjs/core/exceptions'

export default class CentralRouteViolationException extends Exception {
  static readonly status = 404
  static readonly code = 'E_CENTRAL_ROUTE_VIOLATION'
  static readonly message = 'This route is only available on the central domain'
}

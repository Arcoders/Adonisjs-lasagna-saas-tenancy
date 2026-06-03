import { Exception } from '@adonisjs/core/exceptions'

export default class RateLimitUnavailableException extends Exception {
  static readonly status = 503
  static readonly code = 'E_RATE_LIMIT_UNAVAILABLE'
  static readonly message = 'Rate limit backend is unavailable. Please retry shortly.'
}

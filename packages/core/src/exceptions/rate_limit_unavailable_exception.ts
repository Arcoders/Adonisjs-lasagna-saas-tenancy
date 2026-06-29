import { Exception } from '@adonisjs/core/exceptions'

/**
 * AdonisJS exception thrown when the Redis-backed rate-limit backend cannot be
 * reached and the route is not configured to fail open, so the request is
 * rejected rather than allowed through unmetered. It extends the framework
 * Exception class and carries a 503 HTTP status, the stable code
 * `E_RATE_LIMIT_UNAVAILABLE`, and a retry-shortly message, signalling callers
 * that the limiter is temporarily degraded.
 */
export default class RateLimitUnavailableException extends Exception {
  static readonly status = 503
  static readonly code = 'E_RATE_LIMIT_UNAVAILABLE'
  static readonly message = 'Rate limit backend is unavailable. Please retry shortly.'
}

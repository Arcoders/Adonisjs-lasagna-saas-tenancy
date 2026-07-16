import { Exception } from '@adonisjs/core/exceptions'

/**
 * Exception thrown when a client exceeds an allowed request rate, signalling that
 * the caller should back off and retry later. It extends the AdonisJS base
 * Exception with a fixed HTTP 429 status, the error code E_TOO_MANY_REQUESTS, and
 * a default human-readable message asking the client to slow down.
 */
export default class TooManyRequestsException extends Exception {
  static readonly status = 429
  static readonly code = 'E_TOO_MANY_REQUESTS'
  static readonly message = 'Too many requests. Please slow down and try again later'
}

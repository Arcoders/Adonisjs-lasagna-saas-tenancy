import { Exception } from '@adonisjs/core/exceptions'

/**
 * Exception thrown when a tenant service circuit breaker is open and requests are short-circuited.
 * Extends the AdonisJS base Exception, carrying an HTTP 503 status, the code `E_CIRCUIT_OPEN`,
 * and a message signalling that the tenant service is temporarily unavailable while the circuit is open.
 */
export default class CircuitOpenException extends Exception {
  static readonly status = 503
  static readonly code = 'E_CIRCUIT_OPEN'
  static readonly message = 'Tenant service temporarily unavailable. Circuit is open.'
}

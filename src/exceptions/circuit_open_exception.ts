import { Exception } from '@adonisjs/core/exceptions'

export default class CircuitOpenException extends Exception {
  static readonly status = 503
  static readonly code = 'E_CIRCUIT_OPEN'
  static readonly message = 'Tenant service temporarily unavailable. Circuit is open.'
}

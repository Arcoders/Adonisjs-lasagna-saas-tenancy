import { Exception } from '@adonisjs/core/exceptions'

export default class TooManyRequestsException extends Exception {
  static readonly status = 429
  static readonly code = 'E_TOO_MANY_REQUESTS'
  static readonly message = 'Too many requests. Please slow down and try again later'
}

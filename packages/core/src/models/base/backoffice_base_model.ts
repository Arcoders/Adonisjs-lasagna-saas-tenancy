import { BaseModel } from '@adonisjs/lucid/orm'
import type { IsolationKind } from './isolation_kind.js'

export class BackofficeBaseModel extends BaseModel {
  static connection = 'backoffice'
  /** Routed to the shared backoffice schema by the unified adapter. */
  static isolation: IsolationKind = 'backoffice'
}

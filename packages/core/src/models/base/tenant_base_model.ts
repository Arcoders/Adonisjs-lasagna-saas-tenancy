import { BaseModel } from '@adonisjs/lucid/orm'
import type { IsolationKind } from './isolation_kind.js'

export class TenantBaseModel extends BaseModel {
  /** Routed to per-tenant storage by the active IsolationDriver. */
  static isolation: IsolationKind = 'tenant'
}

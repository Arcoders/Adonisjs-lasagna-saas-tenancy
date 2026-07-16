import { BaseModel, CamelCaseNamingStrategy } from '@adonisjs/lucid/orm'
import type { LucidModel } from '@adonisjs/lucid/types/model'
import { getConfig } from '../../config.js'
import type { IsolationKind } from './isolation_kind.js'

class CentralNamingStrategy extends CamelCaseNamingStrategy {
  tableName(model: LucidModel): string {
    return `${getConfig().centralSchemaName}.${super.tableName(model)}`
  }
}

export class CentralBaseModel extends BaseModel {
  static connection = 'public'
  static namingStrategy = new CentralNamingStrategy()
  /** Routed to the central/default connection by the unified adapter. */
  static isolation: IsolationKind = 'central'
}

import { BaseModel, CamelCaseNamingStrategy } from '@adonisjs/lucid/orm'
import type { LucidModel } from '@adonisjs/lucid/types/model'
import { getConfig } from '../../config.js'

class CentralNamingStrategy extends CamelCaseNamingStrategy {
  tableName(model: LucidModel): string {
    return `${getConfig().centralSchemaName}.${super.tableName(model)}`
  }
}

export class CentralBaseModel extends BaseModel {
  static connection = 'public'
  static namingStrategy = new CentralNamingStrategy()
}

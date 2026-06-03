import { BaseModel } from '@adonisjs/lucid/orm'

export class BackofficeBaseModel extends BaseModel {
  static connection = 'backoffice'
}

import { getConfig } from '../../config.js'
import DefaultLucidAdapter from './default_lucid_adapter.js'
import type { LucidModel, ModelAdapterOptions } from '@adonisjs/lucid/types/model'

export default class BackofficeAdapter extends DefaultLucidAdapter {
  override query(modelConstructor: LucidModel, options?: ModelAdapterOptions): any {
    const client = this.modelConstructorClient(modelConstructor, options)
    return client.modelQuery(modelConstructor).withSchema(getConfig().backofficeSchemaName)
  }
}

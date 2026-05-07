// Source: https://github.com/adonisjs/lucid/blob/develop/src/orm/adapter/index.ts

import { Exception } from '@adonisjs/core/exceptions'
import type {
  LucidRow,
  LucidModel,
  AdapterContract,
  ModelAdapterOptions,
} from '@adonisjs/lucid/types/model'
import type { Database } from '@adonisjs/lucid/database'

const isObject = (value: unknown): value is object => {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export default class DefaultLucidAdapter implements AdapterContract {
  constructor(protected db: Database) {}

  private getPrimaryKeyColumnName(Model: LucidModel) {
    return Model.$keys.attributesToColumns.get(Model.primaryKey, Model.primaryKey)
  }

  modelConstructorClient(modelConstructor: LucidModel, options?: ModelAdapterOptions) {
    if (options && options.client) {
      return options.client
    }

    const connection = (options && options.connection) || modelConstructor.connection
    return this.db.connection(connection)
  }

  query(modelConstructor: LucidModel, options?: ModelAdapterOptions): any {
    const client = this.modelConstructorClient(modelConstructor, options)
    return client.modelQuery(modelConstructor)
  }

  modelClient(instance: LucidRow): any {
    const modelConstructor = instance.constructor as unknown as LucidModel
    return instance.$trx
      ? instance.$trx
      : this.modelConstructorClient(modelConstructor, instance.$options)
  }

  async insert(instance: LucidRow, attributes: any) {
    const query = instance.$getQueryFor('insert', this.modelClient(instance))

    const Model = instance.constructor as LucidModel
    const result = await query.insert(attributes).reporterData({ model: Model.name })

    if (!Model.selfAssignPrimaryKey && Array.isArray(result) && result[0]) {
      if (isObject(result[0])) {
        instance.$consumeAdapterResult(result[0])
      } else {
        const primaryKeyColumnName = this.getPrimaryKeyColumnName(Model)
        instance.$consumeAdapterResult({ [primaryKeyColumnName]: result[0] })
      }
    }
  }

  async update(instance: LucidRow, dirty: any) {
    await instance.$getQueryFor('update', this.modelClient(instance)).update(dirty)
  }

  async delete(instance: LucidRow) {
    await instance.$getQueryFor('delete', this.modelClient(instance)).del()
  }

  async refresh(instance: LucidRow) {
    const Model = instance.constructor as LucidModel
    const primaryKeyColumnName = this.getPrimaryKeyColumnName(Model)

    const freshModelInstance = await instance
      .$getQueryFor('refresh', this.modelClient(instance))
      .first()

    if (!freshModelInstance) {
      throw new Exception(
        [
          '"Model.refresh" failed. ',
          `Unable to lookup "${Model.table}" table where "${primaryKeyColumnName}" = ${instance.$primaryKeyValue}`,
        ].join('')
      )
    }

    instance.fill(freshModelInstance.$attributes)
    instance.$hydrateOriginals()
  }
}

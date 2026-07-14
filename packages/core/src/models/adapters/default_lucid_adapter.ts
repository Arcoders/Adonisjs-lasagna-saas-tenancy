// Source: https://github.com/adonisjs/lucid/blob/develop/src/orm/adapter/index.ts
//
// Near-verbatim port of Lucid's own ORM adapter. The `any` return and parameter
// types below intentionally mirror upstream's `AdapterContract` (the query
// builder / row shapes Lucid itself leaves untyped). Keep them in lockstep with
// upstream rather than tightening them here, or a future Lucid sync becomes a
// painful merge for no real safety gain.

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

  /**
   * The write/refresh query builder for a model instance, keyed by action. A
   * single seam (not in upstream's port) so a subclass can schema-qualify the
   * write path the way `query()` qualifies reads — `insert`/`update`/`delete`/
   * `refresh` all bypass `query()`, so without this each would resolve its schema
   * through the connection's search_path. The base is behavior-identical; it just
   * centralizes the `$getQueryFor` call. See `TenantAdapter.queryForInstance`.
   */
  protected queryForInstance(
    instance: LucidRow,
    action: 'insert' | 'update' | 'delete' | 'refresh'
  ): any {
    // `$getQueryFor` is overloaded per literal action; the union widens past both
    // overloads, so erase it (the method returns `any` regardless, as elsewhere here).
    return instance.$getQueryFor(action as 'insert', this.modelClient(instance))
  }

  async insert(instance: LucidRow, attributes: any) {
    const query = this.queryForInstance(instance, 'insert')

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
    await this.queryForInstance(instance, 'update').update(dirty)
  }

  async delete(instance: LucidRow) {
    await this.queryForInstance(instance, 'delete').del()
  }

  async refresh(instance: LucidRow) {
    const Model = instance.constructor as LucidModel
    const primaryKeyColumnName = this.getPrimaryKeyColumnName(Model)

    const freshModelInstance = await this.queryForInstance(instance, 'refresh').first()

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

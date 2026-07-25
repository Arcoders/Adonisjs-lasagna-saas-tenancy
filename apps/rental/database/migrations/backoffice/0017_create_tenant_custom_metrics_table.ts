import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tenant_custom_metrics'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.uuid('tenant_id').notNullable()
      table.date('period').notNullable()
      table.string('name', 63).notNullable()
      table.bigInteger('value').notNullable().defaultTo(0)
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.unique(['tenant_id', 'period', 'name'])
      table.index('period')
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

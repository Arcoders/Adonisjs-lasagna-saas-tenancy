import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tenant_metrics_monthly'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.uuid('tenant_id').notNullable()
      table.date('month').notNullable()
      table.bigInteger('request_count').notNullable().defaultTo(0)
      table.bigInteger('error_count').notNullable().defaultTo(0)
      table.bigInteger('bandwidth_bytes').notNullable().defaultTo(0)
      table.timestamp('computed_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.unique(['tenant_id', 'month'])
      table.index('month')
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

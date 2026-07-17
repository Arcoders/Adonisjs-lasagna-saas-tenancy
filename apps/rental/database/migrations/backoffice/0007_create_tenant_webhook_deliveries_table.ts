import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tenant_webhook_deliveries'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table
        .uuid('webhook_id')
        .notNullable()
        .references('id')
        .inTable('backoffice.tenant_webhooks')
        .onDelete('CASCADE')
      table.string('event').notNullable()
      table.jsonb('payload').notNullable()
      table.integer('status_code').nullable()
      table.text('response_body').nullable()
      table.integer('attempt').notNullable().defaultTo(1)
      table
        .enum('status', ['pending', 'success', 'failed', 'retrying'])
        .notNullable()
        .defaultTo('pending')
      table.timestamp('next_retry_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['status', 'next_retry_at'])
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

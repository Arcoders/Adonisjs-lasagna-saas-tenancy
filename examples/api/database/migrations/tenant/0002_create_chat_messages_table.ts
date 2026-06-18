import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Tenant-scoped migration for the WebSockets chat demo. Runs against the
 * per-tenant connection, so `createTable('chat_messages')` lands inside
 * `tenant_<uuid>.chat_messages`. Triggered by `node ace tenant:migrate`.
 */
export default class extends BaseSchema {
  protected tableName = 'chat_messages'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table.text('body').notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}

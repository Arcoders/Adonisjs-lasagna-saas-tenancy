import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Tenant-scoped migration. Runs against the per-tenant connection
 * (`tenant_<uuid>`) whose searchPath is set to that tenant's schema, so
 * `createTable('notes')` lands inside `tenant_<uuid>.notes`.
 *
 * Triggered by `node ace tenant:migrate --tenant=<uuid>` or
 * `node ace tenant:migrate` (all active tenants).
 */
export default class extends BaseSchema {
  protected tableName = 'notes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').primary()
      table.string('title').notNullable()
      table.text('body').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}

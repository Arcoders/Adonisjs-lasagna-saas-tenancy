import { BaseSchema } from '@adonisjs/lucid/schema'

// Mirrors the package's add_maintenance_to_tenants_table stub so
// tenant:maintenance + TenantGuardMiddleware's 503 gate work in the demo.
export default class extends BaseSchema {
  protected tableName = 'tenants'

  async up() {
    this.schema.withSchema('backoffice').alterTable(this.tableName, (table) => {
      table.boolean('maintenance').notNullable().defaultTo(false)
      table.text('maintenance_message').nullable()
    })
  }

  async down() {
    this.schema.withSchema('backoffice').alterTable(this.tableName, (table) => {
      table.dropColumn('maintenance')
      table.dropColumn('maintenance_message')
    })
  }
}

import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Adds maintenance-mode columns to the tenants registry, mirroring the
 * package's `add_maintenance_to_tenants_table` migration stub. With these,
 * `tenant:maintenance` (and `TenantGuardMiddleware`'s 503 gate) work against
 * the demo Tenant model — see `enterMaintenance`/`exitMaintenance`/`isMaintenance`
 * in app/models/backoffice/tenant.ts.
 */
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

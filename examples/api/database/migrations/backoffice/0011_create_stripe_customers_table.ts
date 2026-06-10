import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One row per tenant. The mapping `tenant_id ↔ stripe_customer_id` is the
 * keystone of every webhook lookup: the package never stores
 * `stripe_customer_id` on the host's Tenant model. Webhook handlers resolve
 * the tenant via this table.
 */
export default class extends BaseSchema {
  protected tableName = 'stripe_customers'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('tenant_id').primary()
      table.string('stripe_customer_id').notNullable().unique()
      table.string('default_payment_method').nullable()
      table.string('currency').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('deleted_at', { useTz: true }).nullable()
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * One row per tenant. The mapping `tenant_id ↔ provider_customer_id` is the
 * keystone of every webhook lookup: the package never stores the provider
 * customer id on the host's Tenant model. `provider` records which driver owns
 * the id.
 */
export default class extends BaseSchema {
  protected tableName = 'billing_customers'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('tenant_id').primary()
      table.string('provider').notNullable()
      table.string('provider_customer_id').notNullable()
      table.string('default_payment_method').nullable()
      table.string('currency').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('deleted_at', { useTz: true }).nullable()
      table.unique(['provider', 'provider_customer_id'])
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

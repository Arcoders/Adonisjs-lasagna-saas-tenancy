import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Audit ledger for usage-based / metered billing reports. Each row maps to one
 * report through the active driver's metering API. `provider` records which
 * driver it was sent through; `idempotency_key` is unique at the DB layer
 * (defense in depth) and sent to the provider.
 */
export default class extends BaseSchema {
  protected tableName = 'billing_usage_events'

  async up() {
    this.schema.raw('CREATE EXTENSION IF NOT EXISTS pgcrypto')
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('provider').notNullable()
      table.uuid('tenant_id').notNullable().index()
      table.string('meter_event_name').notNullable()
      table.bigInteger('quantity').notNullable()
      table.string('idempotency_key').notNullable().unique()
      table.timestamp('reported_at', { useTz: true }).nullable()
      table.enum('status', ['pending', 'sent', 'failed']).notNullable().defaultTo('pending')
      table.text('last_error').nullable()
      table.integer('attempts').notNullable().defaultTo(0)
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['tenant_id', 'meter_event_name', 'status'])
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

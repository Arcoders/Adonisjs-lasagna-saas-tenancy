import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Webhook idempotency ledger. The controller does `INSERT ... ON CONFLICT
 * (event_id) DO NOTHING`; a 0-row result means the event is a duplicate and is
 * acked without dispatching the job. `provider` records the source driver;
 * `payload` is the replay fallback for events the provider can no longer return.
 */
export default class extends BaseSchema {
  protected tableName = 'billing_processed_events'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.string('event_id').primary()
      table.string('provider').notNullable()
      table.string('event_type').notNullable()
      table.timestamp('processed_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('completed_at', { useTz: true }).nullable()
      table.uuid('tenant_id').nullable()
      table.integer('attempts').notNullable().defaultTo(0)
      table.text('last_error').nullable()
      table
        .enum('status', ['pending', 'processing', 'completed', 'failed'])
        .notNullable()
        .defaultTo('pending')
      table.jsonb('payload').nullable()
      table.index(['status', 'processed_at'])
      table.index(['event_type'])
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Local mirror of Stripe subscriptions. Reconciled by `tenant:billing:sync`.
 * `last_event_at` is the ordering guard against out-of-order webhook delivery;
 * `raw` jsonb preserves the full Stripe payload.
 */
export default class extends BaseSchema {
  protected tableName = 'stripe_subscriptions'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.string('stripe_subscription_id').primary()
      table
        .uuid('tenant_id')
        .nullable()
        .references('tenant_id')
        .inTable('backoffice.stripe_customers')
        .onDelete('SET NULL')
      table
        .enum('status', [
          'incomplete',
          'incomplete_expired',
          'trialing',
          'active',
          'past_due',
          'canceled',
          'unpaid',
          'paused',
        ])
        .notNullable()
      table.timestamp('current_period_start', { useTz: true }).notNullable()
      table.timestamp('current_period_end', { useTz: true }).notNullable()
      table.boolean('cancel_at_period_end').notNullable().defaultTo(false)
      table.timestamp('cancel_at', { useTz: true }).nullable()
      table.timestamp('canceled_at', { useTz: true }).nullable()
      table.timestamp('trial_end', { useTz: true }).nullable()
      table.string('plan_name').notNullable()
      table.timestamp('last_event_at', { useTz: true }).notNullable()
      table.jsonb('raw').notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['tenant_id', 'status'])
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

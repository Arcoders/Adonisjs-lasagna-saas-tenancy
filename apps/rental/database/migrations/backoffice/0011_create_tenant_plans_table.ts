import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Source-of-truth for tenant-to-plan assignments. Read by
 * `QuotaService.getAssignedPlan` (with BentoCache 60s) when
 * `config.plans.getPlan` is undefined, and written by `assignPlan`
 * (manual assignment, or `source='stripe'` from the billing satellite).
 */
export default class extends BaseSchema {
  protected tableName = 'tenant_plans'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('tenant_id').primary()
      table.string('plan_name').notNullable()
      table.string('source').notNullable().defaultTo('manual')
      table.timestamp('assigned_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('expires_at', { useTz: true }).nullable()
      table.index(['expires_at'])
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

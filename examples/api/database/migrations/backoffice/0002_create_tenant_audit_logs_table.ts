import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tenant_audit_logs'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.uuid('tenant_id').nullable()
      table.string('actor_type').notNullable()
      table.uuid('actor_id').nullable()
      table.string('action').notNullable()
      table.jsonb('metadata').nullable()
      table.string('ip_address').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())

      // Composite index matching AuditLogService.listForTenant (filter tenant_id,
      // order by created_at desc) — serves both the filter and the sort, and a
      // tenant-prefixed lookup still uses it.
      table.index(['tenant_id', 'created_at'], 'tenant_audit_logs_tenant_created_idx')
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

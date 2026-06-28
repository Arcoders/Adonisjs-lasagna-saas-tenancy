import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tenant_audit_logs'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.uuid('tenant_id').nullable()
      table.string('actor_type').notNullable()
      // Free-form operator identity (uuid, int-as-string, email), not a tenant id.
      // Text, not uuid, so a non-uuid admin id is recorded instead of dropped.
      table.string('actor_id').nullable()
      table.string('action').notNullable()
      table.jsonb('metadata').nullable()
      table.string('ip_address').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())

      // Composite index matching AuditLogService.listForTenant (filter tenant_id,
      // order by created_at desc) — serves both the filter and the sort, and a
      // tenant-prefixed lookup still uses it.
      table.index(['tenant_id', 'created_at'], 'tenant_audit_logs_tenant_created_idx')
    })

    // Audit logs are append-only. Enforce it at the database level so a
    // compromised tenant role, or a buggy controller, cannot rewrite or erase
    // evidence. This mirrors the package's canonical migration stub
    // (packages/core/stubs/migrations/create_tenant_audit_logs_table.stub); the
    // demo originally shipped the table without these guards. The triggers fire
    // regardless of role, unlike a REVOKE the table owner can bypass.
    this.defer(async (db) => {
      await db.rawQuery(`
        CREATE OR REPLACE FUNCTION backoffice.tenant_audit_logs_no_mutate()
        RETURNS TRIGGER AS $$
        BEGIN
          RAISE EXCEPTION 'tenant_audit_logs is append-only; UPDATE/DELETE is forbidden'
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS tenant_audit_logs_no_update ON backoffice.tenant_audit_logs;
        CREATE TRIGGER tenant_audit_logs_no_update
        BEFORE UPDATE ON backoffice.tenant_audit_logs
        FOR EACH ROW EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate();
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS tenant_audit_logs_no_delete ON backoffice.tenant_audit_logs;
        CREATE TRIGGER tenant_audit_logs_no_delete
        BEFORE DELETE ON backoffice.tenant_audit_logs
        FOR EACH ROW EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate();
      `)
      // TRUNCATE bypasses per-row triggers, so it needs its own statement-level
      // guard — without it a single TRUNCATE would erase the whole history.
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS tenant_audit_logs_no_truncate ON backoffice.tenant_audit_logs;
        CREATE TRIGGER tenant_audit_logs_no_truncate
        BEFORE TRUNCATE ON backoffice.tenant_audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION backoffice.tenant_audit_logs_no_mutate();
      `)
    })
  }

  async down() {
    this.defer(async (db) => {
      await db.rawQuery(
        'DROP TRIGGER IF EXISTS tenant_audit_logs_no_update ON backoffice.tenant_audit_logs'
      )
      await db.rawQuery(
        'DROP TRIGGER IF EXISTS tenant_audit_logs_no_delete ON backoffice.tenant_audit_logs'
      )
      await db.rawQuery(
        'DROP TRIGGER IF EXISTS tenant_audit_logs_no_truncate ON backoffice.tenant_audit_logs'
      )
      await db.rawQuery('DROP FUNCTION IF EXISTS backoffice.tenant_audit_logs_no_mutate()')
    })
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

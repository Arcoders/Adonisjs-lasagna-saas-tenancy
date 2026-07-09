import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The shared WORM (write-once, read-many) shred ledger, in the backoffice schema.
 * The crypto satellite's two-phase crypto-shred writes an append-only, per-tenant
 * hash-chained audit row here BEFORE it destroys a DEK and confirms it AFTER, so an
 * erasure is never left silently unaudited. Materialized from core's
 * `stubs/migrations/create_worm_ledger_table.stub` (the configure hook copies it
 * into a host app; the demo pins it here so `backoffice:setup` provisions it and the
 * crypto e2e can assert the ledger is append-only).
 */
export default class extends BaseSchema {
  protected tableName = 'worm_ledger'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.uuid('tenant_id').notNullable()

      // Per-tenant monotonic sequence + hash chain: `checksum` is
      // sha256(canonical(row, seq) + '\n' + prev_checksum), computed in the writer,
      // so a deletion/reorder/in-place rewrite that slips past the triggers breaks
      // the chain and verify() reports it. UNIQUE(tenant_id, seq) backs the writer.
      table.bigInteger('seq').notNullable()
      table.specificType('checksum', 'char(64)').notNullable()
      table.specificType('prev_checksum', 'char(64)').nullable()

      // Non-PII payload only: `subject_hash` is a one-way digest of the data subject
      // (never the raw id), `action` namespaces the event, `metadata` holds non-PII
      // structured extras. Keeping the ledger forever therefore leaks nothing.
      table.string('action').notNullable()
      table.specificType('subject_hash', 'char(64)').nullable()
      table.string('category').nullable()
      table.string('reason').nullable()
      table.jsonb('metadata').notNullable().defaultTo('{}')

      table.timestamp('occurred_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.unique(['tenant_id', 'seq'], 'worm_ledger_tenant_seq_uq')
      table.index(['tenant_id', 'created_at'], 'worm_ledger_tenant_created_idx')
    })

    // Append-only, enforced at the DB level so a compromised tenant role or a buggy
    // controller cannot rewrite or erase evidence. The triggers fire on every
    // UPDATE/DELETE/TRUNCATE regardless of role (unlike REVOKE, which the owner
    // bypasses). This is why the two-phase shred marks COMMITTED by APPENDING a
    // second row, never by UPDATE-ing the PENDING one.
    this.defer(async (db) => {
      await db.rawQuery(`
        CREATE OR REPLACE FUNCTION backoffice.worm_ledger_no_mutate()
        RETURNS TRIGGER AS $$
        BEGIN
          RAISE EXCEPTION 'worm_ledger is append-only; UPDATE/DELETE is forbidden'
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS worm_ledger_no_update ON backoffice.worm_ledger;
        CREATE TRIGGER worm_ledger_no_update
        BEFORE UPDATE ON backoffice.worm_ledger
        FOR EACH ROW EXECUTE FUNCTION backoffice.worm_ledger_no_mutate();
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS worm_ledger_no_delete ON backoffice.worm_ledger;
        CREATE TRIGGER worm_ledger_no_delete
        BEFORE DELETE ON backoffice.worm_ledger
        FOR EACH ROW EXECUTE FUNCTION backoffice.worm_ledger_no_mutate();
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS worm_ledger_no_truncate ON backoffice.worm_ledger;
        CREATE TRIGGER worm_ledger_no_truncate
        BEFORE TRUNCATE ON backoffice.worm_ledger
        FOR EACH STATEMENT EXECUTE FUNCTION backoffice.worm_ledger_no_mutate();
      `)
    })
  }

  async down() {
    this.defer(async (db) => {
      await db.rawQuery('DROP TRIGGER IF EXISTS worm_ledger_no_update ON backoffice.worm_ledger')
      await db.rawQuery('DROP TRIGGER IF EXISTS worm_ledger_no_delete ON backoffice.worm_ledger')
      await db.rawQuery('DROP TRIGGER IF EXISTS worm_ledger_no_truncate ON backoffice.worm_ledger')
      await db.rawQuery('DROP FUNCTION IF EXISTS backoffice.worm_ledger_no_mutate()')
    })
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

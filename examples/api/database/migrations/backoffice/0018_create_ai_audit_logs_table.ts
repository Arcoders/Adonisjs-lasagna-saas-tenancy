import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The dedicated AI audit table (WS-AI-7). The demo enables `config.ai.audit`, so
 * the AI gateway writes a non-PII, append-only, hash-chained row per chat /
 * embedding / retrieval action; `/ai/embed` and `/ai/retrieve` fail CLOSED when
 * this write cannot land, so the table must exist. This mirrors the satellite's
 * `create_ai_audit_logs_table.stub` (the source of truth) that `configure` copies
 * into a host app; the demo carries it as a real backoffice migration so the AI
 * e2e run against a provisioned audit chain.
 */
export default class extends BaseSchema {
  protected tableName = 'ai_audit_logs'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.uuid('tenant_id').notNullable()

      // Per-tenant monotonic sequence + hash chain. `checksum` is computed in the
      // writer as sha256(canonical(row, seq) + '\n' + prev_checksum), so a
      // deletion, reorder, or in-place rewrite that slips past the triggers breaks
      // the chain and `tenant:ai:audit:verify` reports it. `UNIQUE(tenant_id, seq)`
      // backs the advisory-locked writer.
      table.bigInteger('seq').notNullable()
      table.specificType('checksum', 'char(64)').notNullable()
      table.specificType('prev_checksum', 'char(64)').nullable()

      // Non-PII attribution only (I5): principal and source are one-way SHA-256
      // hashes; no prompt, response, query, or document text is ever stored. `op`
      // discriminates the three choke points (chat / embedding / retrieval) whose
      // frozen events map onto this shared row.
      table.string('op').notNullable()
      table.string('outcome').notNullable()
      table.string('reason').nullable()
      table.specificType('principal_hash', 'char(64)').nullable()
      table.specificType('source_hash', 'char(64)').nullable()
      table.string('provider').nullable()
      table.string('model').nullable()
      table.integer('tokens').notNullable().defaultTo(0)
      table.integer('fragments').notNullable().defaultTo(0)
      table.integer('embeddings_count').notNullable().defaultTo(0)
      table.integer('dimension').notNullable().defaultTo(0)
      table.integer('match_count').notNullable().defaultTo(0)
      table.boolean('idempotent_replay').notNullable().defaultTo(false)

      table.timestamp('occurred_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.unique(['tenant_id', 'seq'], 'ai_audit_logs_tenant_seq_uq')
      table.index(['tenant_id', 'created_at'], 'ai_audit_logs_tenant_created_idx')
    })

    // Append-only, enforced at the database level so a compromised tenant role or a
    // buggy controller cannot rewrite or erase evidence. The triggers fire on every
    // UPDATE/DELETE regardless of role; TRUNCATE needs its own statement-level guard.
    this.defer(async (db) => {
      await db.rawQuery(`
        CREATE OR REPLACE FUNCTION backoffice.ai_audit_logs_no_mutate()
        RETURNS TRIGGER AS $$
        BEGIN
          RAISE EXCEPTION 'ai_audit_logs is append-only; UPDATE/DELETE is forbidden'
            USING ERRCODE = 'insufficient_privilege';
        END;
        $$ LANGUAGE plpgsql;
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS ai_audit_logs_no_update ON backoffice.ai_audit_logs;
        CREATE TRIGGER ai_audit_logs_no_update
        BEFORE UPDATE ON backoffice.ai_audit_logs
        FOR EACH ROW EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate();
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS ai_audit_logs_no_delete ON backoffice.ai_audit_logs;
        CREATE TRIGGER ai_audit_logs_no_delete
        BEFORE DELETE ON backoffice.ai_audit_logs
        FOR EACH ROW EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate();
      `)
      await db.rawQuery(`
        DROP TRIGGER IF EXISTS ai_audit_logs_no_truncate ON backoffice.ai_audit_logs;
        CREATE TRIGGER ai_audit_logs_no_truncate
        BEFORE TRUNCATE ON backoffice.ai_audit_logs
        FOR EACH STATEMENT EXECUTE FUNCTION backoffice.ai_audit_logs_no_mutate();
      `)
    })
  }

  async down() {
    this.defer(async (db) => {
      await db.rawQuery(
        'DROP TRIGGER IF EXISTS ai_audit_logs_no_update ON backoffice.ai_audit_logs'
      )
      await db.rawQuery(
        'DROP TRIGGER IF EXISTS ai_audit_logs_no_delete ON backoffice.ai_audit_logs'
      )
      await db.rawQuery(
        'DROP TRIGGER IF EXISTS ai_audit_logs_no_truncate ON backoffice.ai_audit_logs'
      )
      await db.rawQuery('DROP FUNCTION IF EXISTS backoffice.ai_audit_logs_no_mutate()')
    })
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

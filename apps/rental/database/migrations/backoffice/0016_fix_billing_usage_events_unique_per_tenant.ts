import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Re-scope the usage-event idempotency uniqueness from GLOBAL to PER TENANT,
 * matching the shipped `fix_billing_usage_events_unique_per_tenant` stub. 0014
 * already creates the composite for a fresh demo database; this migration exists
 * so a demo database created before 0014 carried the composite (i.e. with the old
 * global `UNIQUE(idempotency_key)`) converges. Idempotent and order-independent:
 * it no-ops when the table is absent and only adds the composite when missing.
 */
export default class extends BaseSchema {
  protected tableName = 'billing_usage_events'

  async up() {
    this.schema.raw(`
      DO $$
      BEGIN
        IF to_regclass('backoffice.billing_usage_events') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE backoffice.billing_usage_events
          DROP CONSTRAINT IF EXISTS billing_usage_events_idempotency_key_unique;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'backoffice'
            AND t.relname = 'billing_usage_events'
            AND c.conname = 'billing_usage_events_tenant_id_idempotency_key_unique'
        ) THEN
          ALTER TABLE backoffice.billing_usage_events
            ADD CONSTRAINT billing_usage_events_tenant_id_idempotency_key_unique
            UNIQUE (tenant_id, idempotency_key);
        END IF;
      END $$;
    `)
  }

  async down() {
    this.schema.raw(`
      DO $$
      BEGIN
        IF to_regclass('backoffice.billing_usage_events') IS NULL THEN
          RETURN;
        END IF;
        ALTER TABLE backoffice.billing_usage_events
          DROP CONSTRAINT IF EXISTS billing_usage_events_tenant_id_idempotency_key_unique;
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint c
          JOIN pg_class t ON t.oid = c.conrelid
          JOIN pg_namespace n ON n.oid = t.relnamespace
          WHERE n.nspname = 'backoffice'
            AND t.relname = 'billing_usage_events'
            AND c.conname = 'billing_usage_events_idempotency_key_unique'
        ) THEN
          ALTER TABLE backoffice.billing_usage_events
            ADD CONSTRAINT billing_usage_events_idempotency_key_unique
            UNIQUE (idempotency_key);
        END IF;
      END $$;
    `)
  }
}

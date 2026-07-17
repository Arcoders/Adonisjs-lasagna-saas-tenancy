import { BaseSchema } from '@adonisjs/lucid/schema'
import { CRYPTO_WRAPPED_DEKS_TABLE } from '@adonisjs-lasagna/crypto'

/**
 * The crypto satellite's per-tenant wrapped-DEK store, materialised here as an
 * app-owned tenant migration.
 *
 * The satellite also ships this via its `perTenantMigrations` manifest, meant to
 * be folded in by `migration:tenant:run`. In this monorepo (workspace-hoisted
 * satellites) the fold does not fire, so the table is provisioned directly. The
 * DDL mirrors the satellite's own so the reviewed non-plaintext column allowlist
 * and the `live_has_key` CHECK are identical.
 */
export default class extends BaseSchema {
  async up() {
    const table = CRYPTO_WRAPPED_DEKS_TABLE
    // safe-sql: `table` is a fixed module constant; no user input.
    this.schema.raw(`
      CREATE TABLE ${table} (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        subject_id text NOT NULL,
        category text NOT NULL,
        wrapped_dek text,
        kek_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        shredded_at timestamptz,
        CONSTRAINT ${table}_live_has_key CHECK (shredded_at IS NOT NULL OR wrapped_dek IS NOT NULL)
      )
    `)
    this.schema.raw(
      `CREATE UNIQUE INDEX ${table}_live_subject_category ON ${table} (subject_id, category) WHERE shredded_at IS NULL`
    )
  }

  async down() {
    this.schema.raw(`DROP TABLE IF EXISTS ${CRYPTO_WRAPPED_DEKS_TABLE}`)
  }
}

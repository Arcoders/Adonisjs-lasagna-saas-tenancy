import { BaseSchema } from '@adonisjs/lucid/schema'
import { CRYPTO_WRAPPED_DEKS_TABLE } from '../src/constants.js'

/**
 * The per-tenant wrapped-DEK table (crypto §6.3, foundation §2.3, SEAM-2, I2/I10).
 * A RUNNABLE per-tenant migration (not a backoffice `.stub`): `tenant:migrate`
 * discovers it via the package's `perTenantMigrations` manifest entry and folds
 * it into the run, so it executes into whatever schema/database the active
 * isolation driver reports. There is NO `withSchema('backoffice')` and NO
 * `tenant_<id>` interpolation: the bare table name lands in the tenant's own
 * placement through the tenant connection's search_path.
 *
 * The row holds a DEK ONLY wrapped under the KEK (`wrapped_dek`), never a
 * plaintext DEK (I2); `kek_id` is the KEK-rotation cursor (I8). The partial
 * `UNIQUE (subject_id, category) WHERE shredded_at IS NULL` makes the LIVE DEK
 * singular (I10, T12) while a shred tombstone (shredded_at set) can remain as
 * evidence AND a later legitimate re-provision inserts a fresh live row (§6.3,
 * decision 6). The column set is the reviewed non-plaintext allowlist that
 * `check-crypto-invariant-2` pins in a later phase.
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
        wrapped_dek text NOT NULL,
        kek_id text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        shredded_at timestamptz
      )
    `)
    // The LIVE (subject × category) DEK is singular; a tombstone is excluded so a
    // re-provision after a shred can insert a fresh live row.
    // safe-sql: `table` is a fixed module constant; no user input.
    this.schema.raw(
      `CREATE UNIQUE INDEX ${table}_live_subject_category ON ${table} (subject_id, category) WHERE shredded_at IS NULL`
    )
  }

  async down() {
    // safe-sql: `table` is a fixed module constant; no user input.
    this.schema.raw(`DROP TABLE IF EXISTS ${CRYPTO_WRAPPED_DEKS_TABLE}`)
  }
}

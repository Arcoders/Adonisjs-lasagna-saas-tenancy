import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fixture migration for satellite_migration_recovery.spec.ts (I3): the SECOND
 * migration in the batch. It simulates a satellite migration that fails mid-batch
 * (bad DDL, missing extension, etc.) on first run, then succeeds once the operator
 * has corrected the cause. The spec flips the global flag to model that fix and
 * re-runs, so this single file covers both the failure and the recovery without
 * editing source between runs.
 *
 * `up()` throws BEFORE scheduling any DDL on the first attempt, so the failing
 * migration leaves no table and Lucid records no ledger row for it (the per-
 * migration transaction rolls back). The corrected re-run then creates the table.
 */
export default class extends BaseSchema {
  protected tableName = 'recovery_step_two'

  async up() {
    if (!(globalThis as any).__satelliteRecoveryFixApplied) {
      throw new Error('simulated bad DDL in a satellite migration (recovery_step_two)')
    }

    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('marker', 255).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}

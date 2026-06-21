import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fixture migration for satellite_migration_recovery.spec.ts (I3): the FIRST
 * migration in a two-migration batch. It always succeeds, so after the batch
 * fails on the second migration this table must still exist and its ledger row
 * must remain — proving Lucid commits each migration in its own transaction.
 */
export default class extends BaseSchema {
  protected tableName = 'recovery_step_one'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('marker', 255).notNullable()
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}

import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The tenants registry. The package's commands and admin routes look up
 * tenants by id; this table is the source of truth.
 *
 * `metadata` is a JSONB column matching the `DemoMeta` interface in
 * app/models/backoffice/tenant.ts. The package never reads it directly —
 * it's consumed via the resolvers in config/multitenancy.ts (`plans.getPlan`,
 * `backup.retention.getTier`).
 */
export default class extends BaseSchema {
  protected tableName = 'tenants'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('name').notNullable()
      table.string('email').notNullable().unique()
      table
        .string('status')
        .notNullable()
        .defaultTo('provisioning')
      table.string('custom_domain').nullable().unique()
      table.jsonb('metadata').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('deleted_at', { useTz: true }).nullable().index()
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

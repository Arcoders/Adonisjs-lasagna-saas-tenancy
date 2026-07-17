import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * The companies registry — one row per rental company (tenant). The package's
 * commands and admin routes look these up by id; the `custom_domain` column is
 * what the `domain-or-subdomain` resolver matches `<slug>.localhost` against.
 *
 * `metadata` is JSONB matching `RentalMeta` in app/models/backoffice/tenant.ts.
 * The package never reads it directly — it flows through the resolvers in
 * config/multitenancy.ts (`plans.getPlan`, `backup.retention.getTier`).
 *
 * The `maintenance` flag + message ship in the create table (not a later alter)
 * so `tenant:maintenance` and TenantGuardMiddleware's 503 gate work from day one.
 */
export default class extends BaseSchema {
  protected tableName = 'tenants'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('name').notNullable()
      table.string('email').notNullable().unique()
      table.string('status').notNullable().defaultTo('provisioning')
      table.string('custom_domain').nullable().unique()
      table.jsonb('metadata').nullable()
      table.boolean('maintenance').notNullable().defaultTo(false)
      table.text('maintenance_message').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('deleted_at', { useTz: true }).nullable().index()
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}

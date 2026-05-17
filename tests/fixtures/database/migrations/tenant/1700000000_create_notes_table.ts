import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Minimal tenant-schema table used by the clone spec to prove the
 * copy phase moves real rows between schemas. Anything that wants to
 * exercise tenant-side data lands here so we don't have to ship a
 * second migration just to add a column.
 */
export default class extends BaseSchema {
  protected tableName = 'notes'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id').notNullable()
      table.string('title', 255).notNullable()
      table.string('body', 1024).nullable()
      table.timestamp('created_at', { useTz: true }).defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}

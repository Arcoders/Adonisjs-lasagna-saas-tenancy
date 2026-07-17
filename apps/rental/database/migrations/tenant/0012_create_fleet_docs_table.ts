import { BaseSchema } from '@adonisjs/lucid/schema'

/** Policy/FAQ documents — the RAG corpus for the fleet assistant. */
export default class extends BaseSchema {
  protected tableName = 'fleet_docs'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.string('title').notNullable()
      table.text('body').notNullable()
      table.string('source').notNullable().unique()
      table.timestamp('embedded_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}

import { BaseSeeder } from '@adonisjs/lucid/seeders'

/**
 * Runs against the active tenant connection. Invoke via:
 *   node ace tenant:seed --tenant=<uuid>
 *   node ace tenant:seed                 # every active tenant
 */
export default class extends BaseSeeder {
  async run() {
    await this.client.table('notes').insert([
      { title: 'Welcome', body: 'This row was inserted by the demo seeder.' },
      { title: 'Hello again', body: 'Schema isolation means a different tenant sees zero rows.' },
    ])
  }
}

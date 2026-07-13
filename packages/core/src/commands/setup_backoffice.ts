import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import { assertSafeIdentifier } from '../isthmus/guarded_identifier.js'

export default class SetupBackoffice extends BaseCommand {
  static readonly commandName = 'backoffice:setup'
  static readonly description = 'Create backoffice schema and run its migrations'
  static readonly options: CommandOptions = { startApp: true }

  async run() {
    const { backofficeSchemaName, backofficeConnectionName } = getConfig()

    // Defense-in-depth: even though the schema name comes from config
    // (not user input), running it through the same identifier guard
    // we use for tenant ids prevents a misconfigured deploy from ever
    // reaching CREATE SCHEMA with a malformed value.
    assertSafeIdentifier(backofficeSchemaName, 'backoffice schema name')
    await db.rawQuery(`CREATE SCHEMA IF NOT EXISTS "${backofficeSchemaName}"`)
    this.logger.success(`Schema "${backofficeSchemaName}" is ready.`)

    const { MigrationRunner } = await import('@adonisjs/lucid/migration')
    const migrator = new MigrationRunner(db, app, {
      direction: 'up',
      connectionName: backofficeConnectionName,
    })

    await migrator.run()

    if (migrator.status === 'error') {
      // Surface the underlying cause and the file that failed. A bare
      // "migration failed" forces the operator to re-run the migration by
      // hand just to see the error.
      const failed = Object.entries(migrator.migratedFiles).find(
        ([, file]) => file.status === 'error'
      )
      if (failed) this.logger.error(`Migration failed: ${failed[0]}`)
      if (migrator.error) this.logger.error(migrator.error.message)
      this.logger.error(
        'Backoffice migration failed. Inspect with: node ace migration:status ' +
          `--connection=${backofficeConnectionName}`
      )
      this.exitCode = 1
      return
    }

    this.logger.success('Backoffice migrations applied.')
  }
}

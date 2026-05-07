import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import { assertSafeIdentifier } from '../services/isolation/identifier.js'

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
      this.logger.error('Backoffice migration failed')
      this.exitCode = 1
      return
    }

    this.logger.success('Backoffice migrations applied.')
  }
}

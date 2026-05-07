import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { resolve } from 'node:path'
import { access } from 'node:fs/promises'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract, TenantModelContract } from '../types/contracts.js'
import SqlImportService from '../services/sql_import_service.js'

export default class ImportTenantSql extends BaseCommand {
  static readonly commandName = 'tenant:import'
  static readonly description = 'Import a PostgreSQL .sql dump file into a tenant schema'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ alias: 't', flagName: 'tenant', description: 'Target tenant ID', required: true })
  declare tenant: string

  @flags.string({ alias: 'f', flagName: 'file', description: 'Path to the .sql dump file', required: true })
  declare file: string

  @flags.string({
    flagName: 'schema-replace',
    description: 'Source schema name in the dump to rewrite (default: public)',
    default: 'public',
  })
  declare schemaReplace: string

  @flags.boolean({ flagName: 'dry-run', description: 'Parse file and report counts without executing', default: false })
  declare dryRun: boolean

  @flags.boolean({ flagName: 'verbose', description: 'Print each failed statement', default: false })
  declare verbose: boolean

  @flags.boolean({ flagName: 'force', description: 'Allow import into non-active tenants', default: false })
  declare force: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    let tenant: TenantModelContract
    try {
      tenant = await repo.findByIdOrFail(this.tenant)
    } catch {
      this.logger.error(`Tenant "${this.tenant}" not found.`)
      this.exitCode = 1
      return
    }

    if (!tenant.isActive && !this.force) {
      this.logger.error(
        `Tenant "${tenant.name}" is not active (status: ${tenant.status}). Use --force to override.`
      )
      this.exitCode = 1
      return
    }

    const filePath = resolve(this.file)
    try {
      await access(filePath)
    } catch {
      this.logger.error(`File not found: ${filePath}`)
      this.exitCode = 1
      return
    }

    const fileName = filePath.split(/[\\/]/).pop() ?? filePath

    if (this.dryRun) {
      this.logger.info(`Dry run — no changes will be made.`)
    }

    const service = new SqlImportService()
    const tasks = this.ui.tasks({ verbose: this.verbose })
    let result: Awaited<ReturnType<typeof service.import>>

    await tasks
      .add(
        `${this.dryRun ? '[dry-run] ' : ''}Importing ${fileName} → ${tenant.schemaName}`,
        async (task) => {
          task.update('Reading and parsing SQL file…')
          try {
            result = await service.import(tenant, filePath, {
              sourceSchema: this.schemaReplace,
              dryRun: this.dryRun,
            })
            return result.errors.length > 0 ? task.error('completed with errors') : 'completed'
          } catch (err: any) {
            return task.error(err.message)
          }
        }
      )
      .run()

    if (!result!) return

    this.logger.info(`  Statements : ${result.statementsTotal} total`)
    this.logger.info(`  Executed   : ${result.statementsExecuted}`)
    this.logger.info(`  Skipped    : ${result.statementsSkipped}`)
    this.logger.info(`  Errors     : ${result.errors.length}`)

    if (result.errors.length > 0) {
      if (this.verbose) {
        for (const { statement, message } of result.errors) {
          this.logger.error(`  [ERR] ${message}`)
          this.logger.error(`        ${statement}`)
        }
      } else {
        this.logger.warning(`Re-run with --verbose to see failed statements.`)
      }
      this.exitCode = 1
    }
  }
}

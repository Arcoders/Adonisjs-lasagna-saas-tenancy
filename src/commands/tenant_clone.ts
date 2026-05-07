import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import CloneService from '../services/clone_service.js'

export default class TenantClone extends BaseCommand {
  static readonly commandName = 'tenant:clone'
  static readonly description =
    'Clone a tenant: provision a new schema and optionally copy all row data from the source'
  static readonly options: CommandOptions = { startApp: true }

  @flags.string({ description: 'Source tenant ID to clone from', alias: 's', required: true })
  declare source: string

  @flags.string({ description: 'Name for the new (destination) tenant', alias: 'n', required: true })
  declare name: string

  @flags.string({ description: 'Email for the new (destination) tenant', alias: 'e', required: true })
  declare email: string

  @flags.boolean({ description: 'Clone schema structure only — skip copying row data', default: false })
  declare schemaOnly: boolean

  @flags.boolean({
    description: 'Wipe access_tokens in destination after copy (recommended)',
    default: true,
  })
  declare clearSessions: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const cloneService = new CloneService()

    let source: Awaited<ReturnType<typeof repo.findByIdOrFail>>
    try {
      source = await repo.findByIdOrFail(this.source)
    } catch {
      this.logger.error(`Source tenant "${this.source}" not found or deleted.`)
      this.exitCode = 1
      return
    }

    if (!source.isActive) {
      this.logger.error(
        `Source tenant "${source.name}" is not active (status: ${source.status}). Only active tenants can be cloned.`
      )
      this.exitCode = 1
      return
    }

    const destination = await repo.create({
      name: this.name,
      email: this.email,
      status: 'provisioning',
    })

    this.logger.info(`Cloning "${source.name}" (${source.id}) → "${this.name}" <${this.email}>`)
    this.logger.info(
      `Mode: ${this.schemaOnly ? 'schema only' : 'schema + data'}` +
        (!this.schemaOnly && this.clearSessions ? ', clear sessions' : '')
    )
    this.logger.info(`Destination tenant created: ${destination.id}`)

    const tasks = this.ui.tasks({ verbose: true })
    let result: Awaited<ReturnType<typeof cloneService.clone>>

    await tasks
      .add('Provisioning destination schema', async (task) => {
        task.update('Creating schema and running migrations…')
        try {
          result = await cloneService.clone(source, destination, {
            schemaOnly: this.schemaOnly,
            clearSessions: this.clearSessions,
          })
          task.update(
            `${result.tablesCopied} table(s) copied, ${result.rowsCopied} row(s) transferred`
          )
          return 'completed'
        } catch (error) {
          return task.error(error.message)
        }
      })
      .run()

    if (!result!) return

    this.logger.success(
      `Tenant "${result.destination.name}" cloned successfully (ID: ${result.destination.id})`
    )

    if (!this.schemaOnly) {
      this.logger.info(`  Tables copied : ${result.tablesCopied}`)
      this.logger.info(`  Rows copied   : ${result.rowsCopied}`)
    }

    this.logger.info(`  Status        : ${result.destination.status}`)
  }
}

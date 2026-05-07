import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { getConfig } from '../config.js'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract, TenantModelContract } from '../types/contracts.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'

export default class TenantSeed extends BaseCommand {
  static readonly commandName = 'tenant:seed'
  static readonly description =
    'Run Lucid seeders against one or more tenant schemas (delegates to db:seed per tenant)'
  static readonly options: CommandOptions = { startApp: true }

  @flags.array({
    alias: 't',
    flagName: 'tenant',
    description: 'Tenant ID(s) to seed; omit to seed every active tenant',
  })
  declare tenant?: string[]

  @flags.array({
    alias: 'f',
    flagName: 'files',
    description: 'Cherry-pick seeder file(s) by relative path; passed through to db:seed',
  })
  declare files?: string[]

  @flags.boolean({
    flagName: 'continue-on-error',
    default: false,
    description: 'Keep seeding remaining tenants when one fails (default: stop on first failure)',
  })
  declare continueOnError: boolean

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    const allActive = await repo.all({ statuses: ['active'] })
    const tenants = this.tenant?.length
      ? allActive.filter((t) => this.tenant!.includes(t.id))
      : allActive

    if (tenants.length === 0) {
      this.logger.info('No matching active tenants found.')
      return
    }

    let succeeded = 0
    let failed = 0

    for (const tenant of tenants) {
      const ok = await this.#seedTenant(tenant)
      if (ok) succeeded++
      else failed++
      if (!ok && !this.continueOnError) break
    }

    this.logger.info(`Done: ${succeeded} succeeded, ${failed} failed`)
    if (failed > 0) this.exitCode = 1
  }

  async #seedTenant(tenant: TenantModelContract): Promise<boolean> {
    const connName = `${getConfig().tenantConnectionNamePrefix}${tenant.id}`

    try {
      const driver = await getActiveDriver()
      await driver.connect(tenant)
    } catch (error: any) {
      this.logger.error(`Could not open connection for ${tenant.id}: ${error.message}`)
      return false
    }

    this.logger.log('')
    this.logger.log(this.colors.bold(`▸ Seeding ${tenant.id} (${tenant.name})`))

    const argv: string[] = ['--connection', connName]
    if (this.files?.length) {
      for (const f of this.files) argv.push('--files', f)
    }

    const result = await this.kernel.exec('db:seed', argv)
    return result.exitCode === 0
  }
}

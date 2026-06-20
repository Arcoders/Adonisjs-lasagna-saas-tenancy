import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import InstallTenant from '../jobs/install_tenant.js'
import TenantCreated from '../events/tenant_created.js'

export default class CreateTenant extends BaseCommand {
  static readonly commandName = 'tenant:create'
  static readonly description = 'Create a new tenant and queue schema provisioning'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant name' })
  declare name: string

  @args.string({ description: 'Tenant contact email' })
  declare email: string

  async run() {
    const repo = await resolveTenantRepository()

    const task = this.ui.tasks()
    let createdTenantId: string | null = null

    await task
      .add(`Creating tenant "${this.name}"`, async (t) => {
        try {
          const tenant = await repo.create({
            name: this.name,
            email: this.email,
            status: 'provisioning',
          })
          createdTenantId = tenant.id
          await TenantCreated.dispatch(tenant)
          t.update(`Tenant created — ID: ${tenant.id}`)
          return 'completed'
        } catch (error) {
          return t.error(error.message)
        }
      })
      .add('Queuing schema provisioning', async (t) => {
        if (!createdTenantId) return t.error('Tenant creation failed; skipping dispatch')
        try {
          await InstallTenant.dispatch({ tenantId: createdTenantId })
          t.update('Install job dispatched')
          return 'completed'
        } catch (error) {
          return t.error(error.message)
        }
      })
      .run()

    if (createdTenantId) {
      this.logger.info('Schema provisioning queued. Run "node ace queue:work" to process it.')
    }
  }
}

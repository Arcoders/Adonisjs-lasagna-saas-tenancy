import { BaseCommand } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'

/**
 * Seeds the platform operator and two demo rental companies. Idempotent, and
 * refuses to run in production (it creates well-known credentials). Chained
 * after `backoffice:setup` by `npm run setup`.
 *
 * The companies are created through the normal lifecycle: each dispatches an
 * InstallTenant job, so `node ace queue:work` must be running to materialise the
 * `tenant_<uuid>` schemas (and the afterMigrate hook seeds an owner in each).
 *
 * Later phases grow this into a full fleet/customer/booking seed.
 */
export default class RentalSeed extends BaseCommand {
  static readonly commandName = 'rental:seed'
  static readonly description = 'Seed the operator account and two demo rental companies'
  static readonly options: CommandOptions = { startApp: true }

  private readonly companies = [
    { name: 'Acme Cars', slug: 'acme', email: 'ops@acme.test', plan: 'fleet' as const },
    {
      name: 'Sahara Cars',
      slug: 'sahara-cars',
      email: 'ops@sahara.test',
      plan: 'starter' as const,
    },
  ]

  async run() {
    if (this.app.inProduction) {
      this.logger.error(
        'rental:seed creates well-known credentials and refuses to run in production.'
      )
      this.exitCode = 1
      return
    }

    const { default: BackofficeUser } = await import('#app/models/backoffice/backoffice_user')
    const { DEMO_OPERATOR, DEMO_TENANT_OWNER } = await import('#app/helpers/rental_credentials')

    await BackofficeUser.updateOrCreate(
      { email: DEMO_OPERATOR.email },
      { password: DEMO_OPERATOR.password, fullName: DEMO_OPERATOR.fullName }
    )
    this.logger.success(`Operator ready: ${DEMO_OPERATOR.email} / ${DEMO_OPERATOR.password}`)

    await this.seedCatalog()

    const { default: Tenant } = await import('#app/models/backoffice/tenant')
    const { default: TenantsService } = await import('#app/services/tenants_service')
    const service = new TenantsService()

    for (const c of this.companies) {
      const existing = await Tenant.query().where('email', c.email).first()
      if (existing) {
        this.logger.info(`Company already present: ${c.name} (${existing.customDomain})`)
        continue
      }
      const tenant = await service.create({
        name: c.name,
        email: c.email,
        slug: c.slug,
        plan: c.plan,
      })
      this.logger.success(`Queued company: ${c.name} → ${tenant.customDomain} (${tenant.id})`)
    }

    this.logger.info('Run `node ace queue:work` to materialise the company schemas.')
    this.logger.info(
      `Then log in as staff on e.g. http://acme.localhost:3333 with ` +
        `${DEMO_TENANT_OWNER.email} / ${DEMO_TENANT_OWNER.password}.`
    )
  }

  /** Seed the shared central car catalog (Moroccan-market makes/models). */
  private async seedCatalog() {
    const { default: CarMake } = await import('#app/models/central/car_make')
    const { default: CarModel } = await import('#app/models/central/car_model')

    const catalog: Array<{ name: string; slug: string; models: Array<[string, string]> }> = [
      {
        name: 'Dacia',
        slug: 'dacia',
        models: [
          ['Logan', 'sedan'],
          ['Sandero', 'hatchback'],
          ['Duster', 'suv'],
        ],
      },
      {
        name: 'Renault',
        slug: 'renault',
        models: [
          ['Clio', 'hatchback'],
          ['Mégane', 'sedan'],
          ['Kangoo', 'van'],
        ],
      },
      {
        name: 'Peugeot',
        slug: 'peugeot',
        models: [
          ['208', 'hatchback'],
          ['301', 'sedan'],
          ['3008', 'suv'],
        ],
      },
      {
        name: 'Toyota',
        slug: 'toyota',
        models: [
          ['Yaris', 'hatchback'],
          ['Corolla', 'sedan'],
          ['RAV4', 'suv'],
        ],
      },
      {
        name: 'Hyundai',
        slug: 'hyundai',
        models: [
          ['i10', 'hatchback'],
          ['Accent', 'sedan'],
          ['Tucson', 'suv'],
        ],
      },
    ]

    let makes = 0
    let models = 0
    for (const m of catalog) {
      const make = await CarMake.updateOrCreate({ slug: m.slug }, { name: m.name, country: 'MA' })
      makes++
      for (const [name, bodyType] of m.models) {
        await CarModel.updateOrCreate({ makeId: make.id, name }, { bodyType })
        models++
      }
    }
    this.logger.success(`Central catalog: ${makes} makes, ${models} models.`)
  }
}

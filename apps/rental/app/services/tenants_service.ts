import { DateTime } from 'luxon'
import { InstallTenant, UninstallTenant } from '@adonisjs-lasagna/saas-tenancy/jobs'
import Tenant, { type RentalMeta } from '#app/models/backoffice/tenant'

export interface CreateCompanyInput {
  name: string
  email: string
  // `| undefined` (not just `?`) so the validator's optional output passes under
  // exactOptionalPropertyTypes; each defaults in `create()` below.
  slug?: string | undefined
  plan?: RentalMeta['plan'] | undefined
  tier?: RentalMeta['tier'] | undefined
  country?: string | undefined
  currency?: string | undefined
}

/** `Acme Cars` → `acme-cars`; the vanity host is `<slug>.localhost`. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'company'
  )
}

/**
 * Company lifecycle operations the controllers delegate to. Keeps the model
 * write + queue dispatch out of the request handler. The `beforeProvision` hook
 * in `config/multitenancy.ts` runs inside InstallTenant and may abort by
 * throwing (the company then flips to status=failed).
 */
export default class TenantsService {
  list() {
    return Tenant.query().orderBy('created_at', 'desc')
  }

  show(id: string) {
    return Tenant.query().where('id', id).first()
  }

  async create(input: CreateCompanyInput) {
    const slug = input.slug ?? slugify(input.name)
    const baseDomain = (await import('#config/multitenancy')).default.baseDomain
    const tenant = await new Tenant()
      .merge({
        name: input.name,
        email: input.email,
        status: 'provisioning',
        customDomain: `${slug}.${baseDomain}`,
        metadata: {
          plan: input.plan ?? 'starter',
          tier: input.tier ?? 'standard',
          country: input.country ?? 'MA',
          currency: input.currency ?? 'MAD',
        },
      })
      .save()

    await InstallTenant.dispatch({ tenantId: tenant.id })
    return tenant
  }

  async activate(id: string) {
    const tenant = await Tenant.findOrFail(id)
    await tenant.activate()
    return tenant
  }

  async suspend(id: string) {
    const tenant = await Tenant.findOrFail(id)
    await tenant.suspend()
    return tenant
  }

  /** Marks the company deleted but preserves its `tenant_<uuid>` schema. */
  async softDelete(id: string) {
    const tenant = await Tenant.findOrFail(id)
    // Invariant A: deletedAt and status move together (the schema is preserved for
    // the retention window, but the lifecycle status must read 'deleted').
    tenant.deletedAt = DateTime.now()
    tenant.status = 'deleted'
    await tenant.save()
    return tenant
  }

  /** Queues UninstallTenant. The job drops the schema. */
  async destroy(id: string) {
    const tenant = await Tenant.findOrFail(id)
    await UninstallTenant.dispatch({ tenantId: tenant.id })
    return tenant
  }
}

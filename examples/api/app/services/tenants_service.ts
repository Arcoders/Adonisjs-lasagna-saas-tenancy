import { DateTime } from 'luxon'
import { InstallTenant, UninstallTenant } from '@adonisjs-lasagna/saas-tenancy/jobs'
import Tenant, { type DemoMeta } from '#app/models/backoffice/tenant'

export interface CreateTenantInput {
  name: string
  email: string
  // `| undefined` (not just `?`) so the validator's optional enum output passes
  // under exactOptionalPropertyTypes; both default in `create()` below.
  plan?: DemoMeta['plan'] | undefined
  tier?: DemoMeta['tier'] | undefined
}

/**
 * Tenant lifecycle operations the controller delegates to. Keeps the model
 * write + queue dispatch out of the request handler so the controller stays
 * a thin transport layer.
 */
export default class TenantsService {
  list() {
    return Tenant.query().orderBy('created_at', 'desc')
  }

  show(id: string) {
    return Tenant.query().where('id', id).first()
  }

  /**
   * Create the registry row and queue the InstallTenant job. The
   * `beforeProvision` hook in `config/multitenancy.ts` runs inside the job
   * and may abort provisioning by throwing.
   */
  async create(input: CreateTenantInput) {
    const tenant = await new Tenant()
      .merge({
        name: input.name,
        email: input.email,
        status: 'provisioning',
        metadata: {
          plan: input.plan ?? 'free',
          tier: input.tier ?? 'standard',
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

  /** Marks the tenant deleted but preserves the `tenant_<uuid>` schema. */
  async softDelete(id: string) {
    const tenant = await Tenant.findOrFail(id)
    // Invariant A: deletedAt and status move together (schema preserved, but the
    // lifecycle status must read 'deleted').
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

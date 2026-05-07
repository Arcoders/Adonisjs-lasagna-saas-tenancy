import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import TenantsService from '#app/services/tenants_service'
import { createTenantValidator } from '#app/validators/tenants_validator'

/**
 * A friendlier façade over the package's admin endpoints — uses the same
 * jobs and lifecycle methods, but exposes simpler shapes for demo curls.
 *
 * Lives alongside `multitenancyAdminRoutes()` (mounted at `/admin`) to
 * demonstrate both styles. Real apps usually pick one.
 */
@inject()
export default class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  async list({ response }: HttpContext) {
    return response.ok({ tenants: await this.tenants.list() })
  }

  async show({ params, response }: HttpContext) {
    const tenant = await this.tenants.show(params.id)
    if (!tenant) return response.notFound({ error: { message: 'tenant not found' } })
    return response.ok({ tenant })
  }

  async create({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createTenantValidator)
    const tenant = await this.tenants.create(payload)
    return response.accepted({
      tenantId: tenant.id,
      status: tenant.status,
      hint: 'Run `node ace queue:work` to materialise the schema',
    })
  }

  async activate({ params, response }: HttpContext) {
    const tenant = await this.tenants.activate(params.id)
    return response.ok({ id: tenant.id, status: tenant.status })
  }

  async suspend({ params, response }: HttpContext) {
    const tenant = await this.tenants.suspend(params.id)
    return response.ok({ id: tenant.id, status: tenant.status })
  }

  /**
   * `?keepSchema=true` soft-deletes (preserves the tenant_<uuid> schema for
   * the retention window). Default queues UninstallTenant which drops it.
   */
  async destroy({ params, request, response }: HttpContext) {
    if (request.input('keepSchema') === 'true') {
      const tenant = await this.tenants.softDelete(params.id)
      return response.ok({
        id: tenant.id,
        softDeleted: true,
        hint: 'Schema preserved — `tenant:purge-expired` will drop it after retentionDays',
      })
    }
    const tenant = await this.tenants.destroy(params.id)
    return response.accepted({ id: tenant.id, scheduledFor: 'tear-down' })
  }

  /** Schema-isolation probe: returns the tenant's named connection. */
  async connection({ request, response }: HttpContext) {
    const tenant = await request.tenant()
    return response.ok({
      tenantId: tenant.id,
      connectionName: tenant.getConnection().connectionName,
    })
  }
}

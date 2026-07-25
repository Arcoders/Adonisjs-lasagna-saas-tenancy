import type { HttpContext } from '@adonisjs/core/http'
import { inject } from '@adonisjs/core'
import TenantsService from '#app/services/tenants_service'
import {
  createTenantValidator,
  destroyTenantQueryValidator,
} from '#app/validators/tenants_validator'
import { currentTenant } from '#app/helpers/current_tenant'

/**
 * A thin operator-facing façade over the company lifecycle. It shares the
 * package's jobs and lifecycle methods with `multitenancyAdminRoutes()` (mounted
 * at `/admin` in the satellite phase) but exposes simpler shapes for the seed
 * and the smoke tests.
 */
@inject()
export default class TenantsController {
  constructor(private readonly tenants: TenantsService) {}

  async list({ response }: HttpContext) {
    return response.ok({ tenants: await this.tenants.list() })
  }

  async show({ params, response }: HttpContext) {
    const tenant = await this.tenants.show(params.id)
    if (!tenant) return response.notFound({ error: { message: 'company not found' } })
    return response.ok({ tenant })
  }

  async create({ request, response }: HttpContext) {
    const payload = await request.validateUsing(createTenantValidator)
    const tenant = await this.tenants.create(payload)
    return response.accepted({
      tenantId: tenant.id,
      status: tenant.status,
      customDomain: tenant.customDomain,
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
   * `?keepSchema=true` soft-deletes (preserves the schema for the retention
   * window). Default queues UninstallTenant, which drops it.
   */
  async destroy({ params, request, response }: HttpContext) {
    const { keepSchema } = await request.validateUsing(destroyTenantQueryValidator)
    if (keepSchema) {
      const tenant = await this.tenants.softDelete(params.id)
      return response.ok({
        id: tenant.id,
        softDeleted: true,
        hint: 'Schema preserved — `tenant:purge-expired` drops it after retentionDays',
      })
    }
    const tenant = await this.tenants.destroy(params.id)
    return response.accepted({ id: tenant.id, scheduledFor: 'tear-down' })
  }

  /** Schema-isolation probe: returns the resolved company's named connection. */
  async connection({ request, response }: HttpContext) {
    const tenant = await currentTenant(request)
    return response.ok({
      tenantId: tenant.id,
      connectionName: tenant.getConnection().connectionName,
    })
  }
}

import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type {
  TenantRepositoryContract,
  TenantStatus,
  TenantModelContract,
} from '../types/contracts.js'
import InstallTenant from '../jobs/install_tenant.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import DoctorService from '../services/doctor/doctor_service.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantCreated from '../events/tenant_created.js'
import TenantActivated from '../events/tenant_activated.js'
import TenantSuspended from '../events/tenant_suspended.js'
import TenantDeleted from '../events/tenant_deleted.js'
import TenantEnteredMaintenance from '../events/tenant_entered_maintenance.js'
import TenantExitedMaintenance from '../events/tenant_exited_maintenance.js'
import ImpersonationService from '../services/impersonation_service.js'

/**
 * Resolver for the acting admin id. Wired by `multitenancyAdminRoutes(...)`.
 * Until set, the impersonation endpoints refuse to issue tokens — we never
 * accept an `adminId` from the request body, since that would let any
 * caller forge the audit trail.
 */
type AdminActorResolver = (ctx: HttpContext) => string | null | Promise<string | null>
let adminActorResolver: AdminActorResolver | null = null
export function __setAdminActorResolver(fn: AdminActorResolver | null): void {
  adminActorResolver = fn
}

const VALID_STATUSES: TenantStatus[] = [
  'provisioning',
  'active',
  'suspended',
  'failed',
  'deleted',
]

function serialize(t: TenantModelContract) {
  return {
    id: t.id,
    name: t.name,
    email: t.email,
    status: t.status,
    customDomain: t.customDomain,
    schemaName: t.schemaName,
    createdAt: t.createdAt?.toISO?.() ?? null,
    deletedAt: t.deletedAt?.toISO?.() ?? null,
    isActive: t.isActive,
    isDeleted: t.isDeleted,
    metadata: t.metadata ?? null,
  }
}

export default class AdminController {
  async list({ request, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const includeDeleted = request.input('includeDeleted', false) === true ||
      request.input('includeDeleted') === 'true'
    const status = request.input('status') as TenantStatus | undefined

    const statuses = status && VALID_STATUSES.includes(status) ? [status] : undefined
    const tenants = await repo.all({ includeDeleted, statuses })
    return response.ok({
      data: tenants.map(serialize),
      total: tenants.length,
    })
  }

  async show({ params, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    return response.ok({ data: serialize(tenant) })
  }

  async create({ request, response }: HttpContext) {
    const name = String(request.input('name') ?? '').trim()
    const email = String(request.input('email') ?? '').trim()
    if (!name || !email) {
      return response.badRequest({ error: 'name_and_email_required' })
    }

    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.create({ name, email, status: 'provisioning' })
    await TenantCreated.dispatch(tenant)
    await InstallTenant.dispatch({ tenantId: tenant.id })
    return response.created({ data: serialize(tenant), provisioning: true })
  }

  async activate({ params, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (tenant.isActive) return response.ok({ data: serialize(tenant), unchanged: true })

    await tenant.activate()
    await TenantActivated.dispatch(tenant)
    return response.ok({ data: serialize(tenant) })
  }

  async suspend({ params, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (tenant.isSuspended) return response.ok({ data: serialize(tenant), unchanged: true })

    await tenant.suspend()
    await TenantSuspended.dispatch(tenant)
    return response.ok({ data: serialize(tenant) })
  }

  async destroy({ params, request, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })

    const keepSchema =
      request.input('keepSchema') === true || request.input('keepSchema') === 'true'

    const hooks = await app.container.make(HookRegistry)
    await hooks.run('before', 'destroy', { tenant })

    const { DateTime } = await import('luxon')
    tenant.deletedAt = DateTime.now()
    await tenant.save()

    if (!keepSchema) {
      const driver = await getActiveDriver()
      await driver.destroy(tenant)
    }

    await hooks.run('after', 'destroy', { tenant })
    await TenantDeleted.dispatch(tenant)
    return response.ok({ data: serialize(tenant), schemaDropped: !keepSchema })
  }

  async restore({ params, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (!tenant.isDeleted) return response.ok({ data: serialize(tenant), unchanged: true })

    tenant.deletedAt = null
    await tenant.save()
    return response.ok({ data: serialize(tenant) })
  }

  async queueStats({ params, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    const stats = await new TenantQueueService().getStats(tenant.id)
    return response.ok({ data: stats })
  }

  async healthReport({ response }: HttpContext) {
    const doctor = await app.container.make(DoctorService)
    const result = await doctor.run()
    response.status(result.totals.error > 0 ? 503 : 200)
    return response.send(result)
  }

  async enterMaintenance({ params, request, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (typeof tenant.enterMaintenance !== 'function') {
      return response.unprocessableEntity({ error: 'maintenance_not_supported_by_model' })
    }
    if (tenant.isMaintenance) return response.ok({ data: serialize(tenant), unchanged: true })

    const message = request.input('message') ?? null
    await tenant.enterMaintenance(message)
    await TenantEnteredMaintenance.dispatch(tenant, message)
    return response.ok({ data: serialize(tenant) })
  }

  async exitMaintenance({ params, response }: HttpContext) {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (typeof tenant.exitMaintenance !== 'function') {
      return response.unprocessableEntity({ error: 'maintenance_not_supported_by_model' })
    }
    if (!tenant.isMaintenance) return response.ok({ data: serialize(tenant), unchanged: true })

    await tenant.exitMaintenance()
    await TenantExitedMaintenance.dispatch(tenant)
    return response.ok({ data: serialize(tenant) })
  }

  async startImpersonation(ctx: HttpContext) {
    const { params, request, response } = ctx
    if (!adminActorResolver) {
      // Without an actor resolver we'd have to trust `adminId` from the
      // request body — which means anyone hitting this endpoint could forge
      // the audit trail. Refuse loudly so the operator wires the hook.
      return response.notImplemented({
        error: 'admin_actor_resolver_not_configured',
        hint: "Pass `resolveAdminActor: ({ auth }) => auth.user?.id` to multitenancyAdminRoutes()",
      })
    }
    const adminId = await adminActorResolver(ctx)
    if (!adminId) {
      return response.unauthorized({ error: 'admin_actor_unresolved' })
    }

    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract
    const tenant = await repo.findById(params.id)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })

    const userId = String(request.input('userId') ?? '').trim()
    if (!userId) {
      return response.badRequest({ error: 'userId_required' })
    }
    const durationSeconds = request.input('durationSeconds')
    const reason = request.input('reason') ?? null

    const svc = await app.container.make(ImpersonationService)
    const result = await svc.start({
      tenantId: tenant.id,
      targetUserId: userId,
      adminId,
      adminType: 'admin',
      durationSeconds:
        typeof durationSeconds === 'number'
          ? durationSeconds
          : Number(durationSeconds) || undefined,
      reason,
      ipAddress: request.ip(),
    })
    return response.created({ data: result })
  }

  async stopImpersonation({ params, request, response }: HttpContext) {
    const svc = await app.container.make(ImpersonationService)
    let revoked = false
    if (params.token) {
      revoked = await svc.stop(params.token, { ipAddress: request.ip() })
    } else if (params.sessionId) {
      revoked = await svc.revokeById(params.sessionId)
    }
    return response.ok({ revoked })
  }
}

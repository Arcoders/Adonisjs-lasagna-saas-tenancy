import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { getAdminActorResolver } from './admin_actor.js'
import { auditAdminAction } from './controllers/helpers.js'
import type { TenantStatus, TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import { InstallTenant } from '@adonisjs-lasagna/saas-tenancy/jobs'
import {
  resolveTenantRepository,
  TenantQueueService,
  DoctorService,
  HookRegistry,
  getActiveDriver,
  ImpersonationService,
} from '@adonisjs-lasagna/saas-tenancy/services'
import {
  TenantCreated,
  TenantActivated,
  TenantSuspended,
  TenantDeleted,
  TenantUpdated,
  TenantEnteredMaintenance,
  TenantExitedMaintenance,
} from '@adonisjs-lasagna/saas-tenancy/events'

// The acting-admin resolver now lives in its own module so satellite
// controllers and the audit helper can read it without importing this
// app-coupled controller. Re-exported as `__setAdminActorResolver` so
// `routes.ts` keeps wiring it through the same name.
export { setAdminActorResolver as __setAdminActorResolver } from './admin_actor.js'

const VALID_STATUSES: TenantStatus[] = ['provisioning', 'active', 'suspended', 'failed', 'deleted']

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
    const repo = await resolveTenantRepository()
    const includeDeleted =
      request.input('includeDeleted', false) === true || request.input('includeDeleted') === 'true'
    const status = request.input('status') as TenantStatus | undefined

    const statuses = status && VALID_STATUSES.includes(status) ? [status] : undefined
    const tenants = await repo.all({ includeDeleted, statuses })
    return response.ok({
      data: tenants.map(serialize),
      total: tenants.length,
    })
  }

  async show({ params, response }: HttpContext) {
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    return response.ok({ data: serialize(tenant) })
  }

  async create(ctx: HttpContext) {
    const { request, response } = ctx
    const name = String(request.input('name') ?? '').trim()
    const email = String(request.input('email') ?? '').trim()
    if (!name || !email) {
      return response.badRequest({ error: 'name_and_email_required' })
    }

    const repo = await resolveTenantRepository()
    const tenant = await repo.create({ name, email, status: 'provisioning' })
    await TenantCreated.dispatch(tenant)
    await InstallTenant.dispatch({ tenantId: tenant.id })
    await auditAdminAction(ctx, 'admin:tenant:create', tenant.id, {
      name: tenant.name,
      status: tenant.status,
    })
    return response.created({ data: serialize(tenant), provisioning: true })
  }

  async activate(ctx: HttpContext) {
    const { params, response } = ctx
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (tenant.isActive) return response.ok({ data: serialize(tenant), unchanged: true })

    await tenant.activate()
    await TenantActivated.dispatch(tenant)
    await auditAdminAction(ctx, 'admin:tenant:activate', tenant.id, { status: tenant.status })
    return response.ok({ data: serialize(tenant) })
  }

  async suspend(ctx: HttpContext) {
    const { params, response } = ctx
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (tenant.isSuspended) return response.ok({ data: serialize(tenant), unchanged: true })

    await tenant.suspend()
    await TenantSuspended.dispatch(tenant)
    await auditAdminAction(ctx, 'admin:tenant:suspend', tenant.id, { status: tenant.status })
    return response.ok({ data: serialize(tenant) })
  }

  async destroy(ctx: HttpContext) {
    const { params, request, response } = ctx
    const repo = await resolveTenantRepository()
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
    // Safe to audit after the schema is dropped: TenantAuditLog lives on the
    // backoffice connection, independent of the tenant schema, and tenantId has
    // no foreign key.
    await auditAdminAction(ctx, 'admin:tenant:destroy', tenant.id, {
      status: tenant.status,
      schemaDropped: !keepSchema,
    })
    return response.ok({ data: serialize(tenant), schemaDropped: !keepSchema })
  }

  async restore(ctx: HttpContext) {
    const { params, response } = ctx
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (!tenant.isDeleted) return response.ok({ data: serialize(tenant), unchanged: true })

    tenant.deletedAt = null
    await tenant.save()
    // Dispatch a lifecycle event so the resolution cache drops the old "deleted"
    // entry on every pod right away. Otherwise a restored tenant keeps getting a
    // 403 until the cache TTL expires. We use TenantUpdated: it's in
    // RESOLUTION_CACHE_INVALIDATING_EVENTS and fits an un-delete. TenantRestored
    // is the backup-restore event and needs a file name.
    await TenantUpdated.dispatch(tenant, { deletedAt: { from: 'set', to: null } })
    await auditAdminAction(ctx, 'admin:tenant:restore', tenant.id, { status: tenant.status })
    return response.ok({ data: serialize(tenant) })
  }

  async queueStats({ params, response }: HttpContext) {
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    const stats = await (await app.container.make(TenantQueueService)).getStats(tenant.id)
    return response.ok({ data: stats })
  }

  async healthReport({ response }: HttpContext) {
    const doctor = await app.container.make(DoctorService)
    const result = await doctor.run()
    response.status(result.totals.error > 0 ? 503 : 200)
    return response.send(result)
  }

  async enterMaintenance(ctx: HttpContext) {
    const { params, request, response } = ctx
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (typeof tenant.enterMaintenance !== 'function') {
      return response.unprocessableEntity({ error: 'maintenance_not_supported_by_model' })
    }
    if (tenant.isMaintenance) return response.ok({ data: serialize(tenant), unchanged: true })

    const message = request.input('message') ?? null
    await tenant.enterMaintenance(message)
    await TenantEnteredMaintenance.dispatch(tenant, message)
    await auditAdminAction(ctx, 'admin:tenant:maintenance_enter', tenant.id, {
      hasMessage: message != null,
    })
    return response.ok({ data: serialize(tenant) })
  }

  async exitMaintenance(ctx: HttpContext) {
    const { params, response } = ctx
    const repo = await resolveTenantRepository()
    const tenant = await repo.findById(params.id, true)
    if (!tenant) return response.notFound({ error: 'tenant_not_found' })
    if (typeof tenant.exitMaintenance !== 'function') {
      return response.unprocessableEntity({ error: 'maintenance_not_supported_by_model' })
    }
    if (!tenant.isMaintenance) return response.ok({ data: serialize(tenant), unchanged: true })

    await tenant.exitMaintenance()
    await TenantExitedMaintenance.dispatch(tenant)
    await auditAdminAction(ctx, 'admin:tenant:maintenance_exit', tenant.id, {})
    return response.ok({ data: serialize(tenant) })
  }

  async startImpersonation(ctx: HttpContext) {
    const { params, request, response } = ctx
    const resolver = getAdminActorResolver()
    if (!resolver) {
      // Without an actor resolver we'd have to trust `adminId` from the
      // request body — which means anyone hitting this endpoint could forge
      // the audit trail. Refuse loudly so the operator wires the hook.
      return response.notImplemented({
        error: 'admin_actor_resolver_not_configured',
        hint: 'Pass `resolveAdminActor: ({ auth }) => auth.user?.id` to multitenancyAdminRoutes()',
      })
    }
    const adminId = await resolver(ctx)
    if (!adminId) {
      return response.unauthorized({ error: 'admin_actor_unresolved' })
    }

    const repo = await resolveTenantRepository()
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

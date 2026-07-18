import { Job } from '@adonisjs/queue'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import { getConfig } from '../config.js'
import { resolveTenantRepository } from '../services/resolve_tenant_repository.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import HookRegistry from '../services/hook_registry.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import { isProvisionableDriver } from '../services/isolation/driver.js'
import { healTenant } from '../services/tenant_healer.js'
import TenantLogContext from '../services/tenant_log_context.js'
import TenantProvisioned from '../events/tenant_provisioned.js'

interface InstallTenantPayload {
  tenantId: string
}

/**
 * Background queue job that provisions a single tenant's storage. It loads the tenant from the
 * repository, transitions its status from provisioning to active (or failed on error), runs the
 * registered before/after provision hooks, delegates schema creation to the active isolation driver
 * (skipping shared-storage drivers that own no per-tenant storage), initializes the tenant's queue,
 * and dispatches the TenantProvisioned event on success.
 *
 * @extends Job<InstallTenantPayload>
 */
export default class InstallTenant extends Job<InstallTenantPayload> {
  // Namespaced so a host app's own `InstallTenant` doesn't collide on
  // the global @adonisjs/queue Locator singleton.
  static options = { name: 'lasagna.InstallTenant' }

  async execute(): Promise<void> {
    const { tenantId } = this.payload
    const logCtx = await app.container.make(TenantLogContext)
    return logCtx.run({ tenantId }, async () => {
      const repo = await resolveTenantRepository()
      const tenant = await repo.findByIdOrFail(tenantId)
      const hooks = await app.container.make(HookRegistry)

      logger.info({ tenantId: tenant.id }, 'Provisioning tenant schema')
      // NOTE: `before:provision` runs on EVERY job attempt (BullMQ retries),
      // whereas `after:provision` only fires once the provision succeeds. Host
      // hooks here must be idempotent: a retried install re-runs them.
      await hooks.run('before', 'provision', { tenant })

      const driver = await getActiveDriver()
      try {
        tenant.status = 'provisioning'
        await tenant.save()
        if (isProvisionableDriver(driver)) {
          await driver.provision(tenant)
        } else {
          // Shared-storage drivers (rowscope-pg) own no per-tenant storage to
          // create (the central tables already exist), so there is nothing to
          // provision. The tenant goes straight to active.
          logger.info(
            { tenantId: tenant.id, driver: driver.name },
            'Driver owns no per-tenant storage; skipping provision step'
          )
        }

        if (getConfig().isolation.migrateOnProvision === true) {
          // Opt-in: migrate + seed BEFORE the tenant goes active, so a freshly
          // onboarded tenant is never left active-but-unmigrated (the failure class
          // that produced a 503 on "Run doctor"). Fire the provision hooks + event
          // first because a seed migration can depend on them (e.g. the pgvector
          // extension); healTenant then sees the just-created schema and only
          // migrates + seeds — it does not re-provision or re-fire the provision
          // hooks. audit:false: the tenant creation is already audited by its own
          // create path. A failure here falls through to the catch → `failed`, never
          // a half-baked active.
          ;(await app.container.make(TenantQueueService)).getOrCreate(tenant.id)
          logger.info({ tenantId: tenant.id }, 'Tenant queue initialized')
          await hooks.run('after', 'provision', { tenant })
          await TenantProvisioned.dispatch(tenant)
          await healTenant(tenant, { fireHooks: true, audit: false })
          tenant.status = 'active'
          await tenant.save()
          logger.info({ tenantId: tenant.id }, 'Tenant provisioned, migrated and active')
          return
        }

        tenant.status = 'active'
        await tenant.save()
      } catch (error) {
        tenant.status = 'failed'
        await tenant.save()
        throw error
      }
      logger.info({ tenantId: tenant.id }, 'Tenant provisioned successfully')
      ;(await app.container.make(TenantQueueService)).getOrCreate(tenant.id)
      logger.info({ tenantId: tenant.id }, 'Tenant queue initialized')

      await hooks.run('after', 'provision', { tenant })
      await TenantProvisioned.dispatch(tenant)
    })
  }

  async failed(error: Error): Promise<void> {
    logger.error(
      { tenantId: this.payload.tenantId, error: error.message },
      'Failed to install tenant'
    )
  }
}

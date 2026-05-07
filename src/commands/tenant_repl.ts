import { BaseCommand, args } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import AuditLogService from '../services/audit_log_service.js'
import FeatureFlagService from '../services/feature_flag_service.js'
import WebhookService from '../services/webhook_service.js'
import BrandingService from '../services/branding_service.js'
import SsoService from '../services/sso_service.js'
import MetricsService from '../services/metrics_service.js'
import TenantQueueService from '../services/tenant_queue_service.js'
import CircuitBreakerService from '../services/circuit_breaker_service.js'
import { getActiveDriver } from '../services/isolation/active_driver.js'
import TenantLogContext from '../services/tenant_log_context.js'

export default class TenantRepl extends BaseCommand {
  static readonly commandName = 'tenant:repl'
  static readonly description =
    'Open a REPL with tenant, db, audit, metrics and the rest of the satellite services preloaded'
  static readonly options: CommandOptions = { startApp: true, staysAlive: true }

  @args.string({ description: 'Tenant ID to load into the REPL context' })
  declare tenantId: string

  async run() {
    const repo = (await this.app.container.make(
      TENANT_REPOSITORY as any
    )) as TenantRepositoryContract
    const tenant = await repo.findById(this.tenantId, true)

    if (!tenant) {
      this.logger.error(`Tenant "${this.tenantId}" not found`)
      this.exitCode = 1
      await this.terminate()
      return
    }

    const driver = await getActiveDriver()
    const db = await driver.connect(tenant)
    const cb = await this.app.container.make(CircuitBreakerService)
    const logCtx = await this.app.container.make(TenantLogContext)

    const repl = await this.app.container.make('repl')

    repl.notify(
      `Loaded tenant ${this.colors.cyan(tenant.id)} (${tenant.name}) — status: ${tenant.status}`
    )
    repl.notify(
      `Available: ${this.colors.dim(
        'tenant, db, audit, featureFlags, webhooks, branding, sso, metrics, queue, circuit, logCtx'
      )}`
    )

    repl.start({
      tenant,
      db,
      audit: new AuditLogService(),
      featureFlags: new FeatureFlagService(),
      webhooks: new WebhookService(),
      branding: new BrandingService(),
      sso: new SsoService(),
      metrics: new MetricsService(),
      queue: new TenantQueueService(),
      circuit: cb,
      logCtx,
    })

    repl.server!.on('exit', async () => {
      await this.terminate()
    })
  }
}

import { BaseCommand, args, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import app from '@adonisjs/core/services/app'
import { TENANT_REPOSITORY } from '../types/contracts.js'
import type { TenantRepositoryContract } from '../types/contracts.js'
import ImpersonationService from '../services/impersonation_service.js'
import CrossDomainRedirectService from '../services/cross_domain_redirect_service.js'

export default class TenantImpersonate extends BaseCommand {
  static readonly commandName = 'tenant:impersonate'
  static readonly description =
    'Issue an admin impersonation token for a target user inside a tenant'
  static readonly options: CommandOptions = { startApp: true }

  @args.string({ description: 'Tenant ID' })
  declare tenantId: string

  @args.string({ description: 'Target user ID inside the tenant' })
  declare userId: string

  @flags.string({ description: 'Acting admin id (free-form, recorded in the audit log)' })
  declare admin: string

  @flags.number({ description: 'Session duration in seconds (default 3600)' })
  declare duration: number

  @flags.string({ description: 'Optional reason recorded in the audit trail' })
  declare reason: string

  @flags.string({
    description: 'Path to embed in the printed redirect URL (default /)',
  })
  declare path: string

  async run() {
    const repo = (await app.container.make(TENANT_REPOSITORY as any)) as TenantRepositoryContract

    try {
      const tenant = await repo.findByIdOrFail(this.tenantId)
      const svc = await app.container.make(ImpersonationService)
      const result = await svc.start({
        tenantId: tenant.id,
        targetUserId: this.userId,
        adminId: this.admin ?? 'cli',
        adminType: 'admin',
        durationSeconds: this.duration,
        reason: this.reason ?? null,
      })

      const redirect = await app.container.make(CrossDomainRedirectService)
      const path = this.path ?? '/'
      const sep = path.includes('?') ? '&' : '?'
      const url = redirect.toTenant(tenant, `${path}${sep}__impersonate=${result.token}`)

      this.logger.success(`Impersonation token issued for tenant "${tenant.name}".`)
      this.logger.info(`token:      ${result.token}`)
      this.logger.info(`session id: ${result.sessionId}`)
      this.logger.info(`expires:    ${new Date(result.expiresAt).toISOString()}`)
      this.logger.info(`url:        ${url}`)
    } catch (error) {
      this.logger.error(`Failed to issue impersonation token: ${error.message}`)
      this.exitCode = 1
    }
  }
}

import { TenantActivated } from '@adonisjs-lasagna/saas-tenancy/events'
import { BrandingService } from '@adonisjs-lasagna/saas-tenancy/services'
import TenantWelcomeMail from '#app/mailers/tenant_welcome_mail'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import type { EmitterService } from '@adonisjs/core/types'

/**
 * Sends the welcome email when a tenant is activated. Pulls the tenant's
 * branding row so each email carries that tenant's own from-address and
 * theme; falls back to defaults from `BrandingService.renderEmailContext`
 * when no row has been customised.
 *
 * Uses synchronous `mail.send` (not `sendLater`) so the demo runs without
 * spinning up a queue worker subprocess. Production consumers should swap
 * to `sendLater`; the queued path is exercised by the dedicated mail spec.
 *
 * Mail subsystem failures are swallowed deliberately — the welcome email
 * is best-effort and must not block tenant activation. The test suite
 * detects an unreachable MailCatcher and skips its assertions.
 */
export default class TenantWelcomeListener {
  static register(emitter: EmitterService): void {
    emitter.on(TenantActivated, async ({ tenant }) => {
      try {
        const branding = new BrandingService()
        const row = await branding.getForTenant(tenant.id)
        const ctx = branding.renderEmailContext(row)

        const { default: mail } = await import('@adonisjs/mail/services/main')
        await mail.send(
          new TenantWelcomeMail(
            { id: tenant.id, name: tenant.name, email: tenant.email },
            {
              fromName: ctx.fromName,
              fromEmail: ctx.fromEmail,
              primaryColor: ctx.primaryColor,
              supportUrl: ctx.supportUrl,
              logoUrl: ctx.logoUrl,
            }
          )
        )
      } catch (error) {
        // Mail subsystem absent or unreachable — non-fatal. Surface a hint in
        // dev (e.g. MailCatcher not running); stay silent and unblocking in prod.
        if (app.inDev) {
          logger.warn(
            { err: error, tenantId: tenant.id },
            '[mail] welcome email failed (non-fatal) — is MailCatcher running?'
          )
        }
      }
    })
  }
}

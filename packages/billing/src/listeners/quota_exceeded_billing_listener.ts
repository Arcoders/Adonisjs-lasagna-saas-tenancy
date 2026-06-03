import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import type { TenantQuotaExceeded } from '@adonisjs-lasagna/saas-tenancy/events'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'

const lazyRedis = () =>
  import('@adonisjs/redis/services/main')
    .then((m) => m.default)
    .catch(() => null)

const lazyMail = () =>
  import('@adonisjs/mail/services/main')
    .then((m) => m.default)
    .catch(() => null)

const DEDUPE_TTL_SECONDS = 24 * 60 * 60

/**
 * Listens for `TenantQuotaExceeded` and dispatches a `QuotaWarningMailer`
 * once per (tenant, quota) per 24h.
 *
 * Why dedupe in Redis (not in DB): the dedupe is purely advisory
 * (no business consequence to a duplicate email beyond annoyance), and
 * Redis SETNX is one round-trip vs a SELECT/INSERT pair against
 * Postgres. The TTL also matches the renewal window we want, so no
 * cleanup job is needed.
 *
 * Wiring is opt-in: registered by `MultitenancyProvider.start()` only
 * when `config.billing.notifyOnQuotaExceeded === true` AND the
 * `@adonisjs/mail` peer dep is bound. Hosts can disable / replace by
 * setting the flag false and subscribing to `TenantQuotaExceeded`
 * themselves.
 */
export default class QuotaExceededBillingListener {
  async handle(event: TenantQuotaExceeded): Promise<void> {
    if (!getConfig().billing?.notifyOnQuotaExceeded) return

    const dedupeKey = `quota_warn:${event.tenant.id}:${event.quota}`
    const redis = await lazyRedis()
    if (redis) {
      // SETNX with TTL — atomic. The first hit wins; subsequent hits
      // within 24h see a 0 return value and skip the mailer dispatch.
      const acquired = await redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
      if (acquired !== 'OK') {
        return
      }
    }

    try {
      const mail = await lazyMail()
      if (!mail) {
        logger.warn(
          { tenant_id: event.tenant.id, quota: event.quota },
          'billing.notify_quota_exceeded.no_mail: @adonisjs/mail not installed — dropping notification'
        )
        return
      }
      // The mailer is published as a stub to the host app and lives at
      // `app/mailers/quota_warning_mailer.ts`. We resolve via container so
      // the host can swap implementations.
      let MailerCtor: any
      try {
        const mod = await import('#mailers/quota_warning_mailer' as string)
        MailerCtor = (mod as any).default
      } catch {
        logger.warn(
          { tenant_id: event.tenant.id },
          'billing.notify_quota_exceeded.no_mailer: app/mailers/quota_warning_mailer.ts not found — run `node ace configure ... --with=billing` to publish it'
        )
        return
      }

      const mailer = await app.container.make(MailerCtor)
      mailer.payload = {
        tenant: event.tenant,
        quota: event.quota,
        limit: event.limit,
        current: event.current,
        attempted: event.attempted,
      }
      await mail.use().sendLater(mailer)
    } catch (err) {
      logger.error(
        { tenant_id: event.tenant.id, err: (err as Error)?.message },
        'billing.notify_quota_exceeded.failed'
      )
    }
  }
}

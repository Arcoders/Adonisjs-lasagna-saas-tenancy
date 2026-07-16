import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import type { TenantQuotaExceeded } from '@adonisjs-lasagna/saas-tenancy/events'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'

const lazyRedis = () =>
  import('@adonisjs/redis/services/main').then((m) => m.default).catch(() => null)

const lazyMail = () =>
  import('@adonisjs/mail/services/main').then((m) => m.default).catch(() => null)

const DEDUPE_TTL_SECONDS = 24 * 60 * 60

/**
 * Listens for `TenantQuotaExceeded` and dispatches a `QuotaWarningMailer`
 * once per (tenant, quota) per 24h.
 *
 * Why dedupe in Redis (not in DB): the dedupe is purely advisory
 * (no business consequence to a duplicate email beyond annoyance), and
 * Redis SETNX is one round-trip vs a SELECT/INSERT pair against
 * Postgres. The TTL also matches the renewal window we want, so no
 * cleanup job is needed. Because it is advisory, the dedupe FAILS OPEN:
 * a Redis outage downgrades to "no dedupe" (a possible duplicate email)
 * rather than throwing or dropping the warning.
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
    if (!(await this.#shouldDispatch(event))) return
    await this.dispatchWarning(event)
  }

  /**
   * Seam (overridable in tests): resolve the Redis client, or `null` when the
   * `@adonisjs/redis` peer isn't installed.
   */
  protected resolveRedis(): ReturnType<typeof lazyRedis> {
    return lazyRedis()
  }

  /**
   * Advisory per-(tenant, quota) dedupe over a 24h window.
   *
   * FAILS OPEN: a Redis outage must never drop a quota warning, so on any Redis
   * error we log and return `true` (dispatch anyway). Both resolving the client
   * and the `SETNX` run inside the try, so any rejection (not just `lazyRedis()`'s
   * caught import failure) fails open. Returns `true` when the caller should
   * dispatch.
   */
  async #shouldDispatch(event: TenantQuotaExceeded): Promise<boolean> {
    try {
      const redis = await this.resolveRedis()
      if (!redis) return true

      const dedupeKey = `quota_warn:${event.tenant.id}:${event.quota}`
      // SETNX with TTL is atomic. The first hit wins; subsequent hits within
      // 24h see a null return value and skip the mailer dispatch.
      const acquired = await redis.set(dedupeKey, '1', 'EX', DEDUPE_TTL_SECONDS, 'NX')
      return acquired === 'OK'
    } catch (err) {
      logger.warn(
        { tenant_id: event.tenant.id, quota: event.quota, err: (err as Error)?.message },
        'billing.notify_quota_exceeded.dedupe_unavailable: redis error, sending without dedupe'
      )
      return true
    }
  }

  /**
   * Seam (overridable in tests): resolve and send the `QuotaWarningMailer`.
   */
  protected async dispatchWarning(event: TenantQuotaExceeded): Promise<void> {
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

import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import { getCache, executeExtension } from '@adonisjs-lasagna/saas-tenancy/services'
import ReportingService from '../reporting_service.js'
import ReportExtensionRegistry from '../report_extension_registry.js'
import {
  REPORT_PERIODS,
  isReportPeriod,
  isValidIsoDate,
  assertWindowWithinMax,
} from '../validate.js'
import { isSafeMetricName } from '../custom_aggregate.js'
import { reportingCacheKey } from '../cache_key.js'
import { REPORTING_CONTRACT_VERSION } from '../constants.js'
import { resolveExtensionGuards } from '../extension_guards.js'
import type { ReportPeriod } from '../types.js'

export interface ReportingControllerOptions {
  /** When > 0, dashboard responses are cached in the global `reporting`
   *  namespace for this many ms. Off by default. */
  cacheTtlMs?: number | undefined
  /** Max allowed span from since to until, in days (default 366). An over-wide or inverted range is a 400. */
  maxRangeDays?: number | undefined
}

/**
 * Read-only dashboard endpoint backing a fleet-wide usage view. Returns the
 * period aggregate, the top tenants, and per-name custom-metric totals in one
 * payload. Mounted via {@link multitenancyReportingRoutes} (fail-closed; host
 * auth applied). Query input is validated here (not just cast) so bad input is a
 * `400`, never a 500 from a malformed SQL query downstream.
 */
export default class ReportingDashboardController {
  constructor(private options: ReportingControllerOptions = {}) {}

  async dashboard(ctx: HttpContext) {
    const period = ctx.request.input('period', 'day')
    if (!isReportPeriod(period)) {
      return ctx.response.badRequest({
        error: `invalid period "${period}" — expected one of ${REPORT_PERIODS.join(', ')}`,
      })
    }

    const since = ctx.request.input('since')
    const until = ctx.request.input('until')
    for (const [name, value] of [
      ['since', since],
      ['until', until],
    ] as const) {
      if (value !== undefined && value !== null && value !== '' && !isValidIsoDate(String(value))) {
        return ctx.response.badRequest({
          error: `invalid ${name} "${value}" — expected ISO date YYYY-MM-DD`,
        })
      }
    }

    // Both bounds present + valid, so enforce the max-range safety cap.
    if (since && until) {
      try {
        assertWindowWithinMax(String(since), String(until), this.options.maxRangeDays ?? 366)
      } catch (error) {
        return ctx.response.badRequest({ error: (error as Error).message })
      }
    }

    const rawLimit = Number(ctx.request.input('limit'))
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined

    const data = await this.#load({ period, since, until, limit })
    return ctx.response.ok({ data })
  }

  /**
   * Run a host-registered report extension. Fail-closed mount applies the host's
   * auth; an unknown or unsafe `:name` is a 404 (never a registry lookup on
   * untrusted input).
   */
  async extension(ctx: HttpContext) {
    const name = ctx.params.name
    if (!isSafeMetricName(name)) {
      return ctx.response.notFound({ error: `unknown report extension "${name}"` })
    }
    const registry = await app.container.make(ReportExtensionRegistry)
    const ext = registry.get(name)
    if (!ext) {
      return ctx.response.notFound({ error: `unknown report extension "${name}"` })
    }
    const filters = {
      since: ctx.request.input('since'),
      until: ctx.request.input('until'),
      period: ctx.request.input('period'),
    }
    // Attribution for the optional rate limit: the client ip when available.
    // `executeExtension` only consults it when `reporting.extensions.rateLimit`
    // is configured; an unguarded surface runs the extension directly.
    const ip = typeof ctx.request.ip === 'function' ? ctx.request.ip() : undefined
    const result = await executeExtension(
      (signal) => ext.execute(filters, undefined, signal),
      resolveExtensionGuards(name, ip)
    )
    return ctx.response.ok({ data: result })
  }

  /**
   * Report the extension-contract version this build implements, so a host can
   * verify compatibility before relying on a custom report. Public metadata
   * behind the same fail-closed mount as the dashboard.
   */
  async contractVersion(ctx: HttpContext) {
    return ctx.response.ok({ version: REPORTING_CONTRACT_VERSION })
  }

  #load(params: {
    period: ReportPeriod
    since?: string | undefined
    until?: string | undefined
    limit?: number | undefined
  }) {
    const ttl = this.options.cacheTtlMs ?? 0
    if (ttl > 0) {
      // Global (backoffice) namespace: reporting data is cross-tenant by design,
      // so this is NEVER a tenant-scoped cache.
      return getCache()
        .namespace('reporting')
        .getOrSet({
          key: reportingCacheKey(params),
          factory: () => this.#compute(params),
          ttl,
        })
    }
    return this.#compute(params)
  }

  async #compute(params: {
    period: ReportPeriod
    since?: string | undefined
    until?: string | undefined
    limit?: number | undefined
  }) {
    const svc = await app.container.make(ReportingService)
    const [aggregate, topTenants, customMetrics, dataAsOf] = await Promise.all([
      svc.getAggregate({ period: params.period, since: params.since, until: params.until }),
      svc.getTopTenants({ since: params.since, until: params.until, limit: params.limit }),
      svc.getCustomMetricsBreakdown({ since: params.since, until: params.until }),
      svc.getDataAsOf(),
    ])
    // `dataAsOf` is the latest FLUSHED period (how current the report is). It rides
    // inside the cached payload (so it's as stale as cacheTtlMs; a flush clears the
    // cache when invalidation is on).
    return { aggregate, topTenants, customMetrics, dataAsOf }
  }
}

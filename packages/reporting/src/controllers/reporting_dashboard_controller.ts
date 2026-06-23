import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import ReportingService from '../reporting_service.js'
import { REPORT_PERIODS, isReportPeriod, isValidIsoDate } from '../validate.js'

/**
 * Read-only dashboard endpoint backing a fleet-wide usage view. Returns the
 * period aggregate + the top tenants in one payload. The host mounts it via
 * {@link multitenancyReportingRoutes}, which is fail-closed and applies the
 * host's admin auth.
 *
 * Query input is validated here (not just cast) so a bad `period` or a non-ISO
 * `since`/`until` returns `400`, never a 500 from a malformed/typed-mismatched
 * SQL query downstream.
 */
export default class ReportingDashboardController {
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

    const rawLimit = Number(ctx.request.input('limit'))
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : undefined

    const svc = await app.container.make(ReportingService)
    const [aggregate, topTenants] = await Promise.all([
      svc.getAggregate({ period, since, until }),
      svc.getTopTenants({ since, until, limit }),
    ])

    return ctx.response.ok({ data: { aggregate, topTenants } })
  }
}

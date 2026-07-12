import { resolveTenantIdSync } from '../extensions/request.js'
import { isSafeIdentifier } from '../services/isolation/identifier.js'
import { tenancy } from '../tenancy.js'
import app from '@adonisjs/core/services/app'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type MetricsService from '../services/metrics_service.js'

/**
 * Per-invocation options for {@link TrackMetricsMiddleware} that tune how the
 * per-tenant metrics middleware records request, error, and bandwidth counters.
 * Set `errorThreshold` to choose the HTTP status at or above which a response is
 * counted as an error (default 500), and `bypassInTestEnv` to control whether the
 * middleware short-circuits when running under `app.inTest` (default true).
 */
export interface TrackMetricsOptions {
  /**
   * HTTP status at or above which a response counts as an error. Default `500`,
   * so 5xx responses bump the per-tenant error counter. Lower it (e.g. `400`) to
   * also count client errors.
   */
  errorThreshold?: number
  /**
   * The middleware short-circuits when `app.inTest` is true so the rest of the
   * integration suite isn't gated on Redis. Default `true`; a spec that targets
   * the recording codepath itself opts in by setting this to `false`.
   */
  bypassInTestEnv?: boolean
}

/**
 * Opt-in middleware that feeds the per-tenant metrics pipeline: after the
 * downstream handler runs it records one request, an error on a >= `errorThreshold`
 * response, and the response bandwidth from `Content-Length` against the resolved
 * tenant. Counters land in Redis (via {@link MetricsService}) and are flushed to
 * `backoffice.tenant_metrics` by the `tenant:metrics:flush` command, the data the
 * `reporting` satellite reads.
 *
 * Recording is **fail-open**: a metrics backend error never breaks the request,
 * and the downstream handler's own error always propagates untouched (only the
 * recording is swallowed). Register it like `RateLimitMiddleware`: the host adds
 * it to its kernel or a route group; there is no config block.
 */
export default class TrackMetricsMiddleware {
  /**
   * Override hook so unit specs can simulate `app.inTest === true` without
   * booting AdonisJS.
   */
  protected isTestEnv(): boolean {
    return (app as any)?.inTest === true
  }

  /**
   * Seam (same pattern as the rate-limit middleware) so unit specs can drive
   * attribution without an AsyncLocalStorage context.
   */
  protected currentTenantId(): string | undefined {
    return tenancy.currentId()
  }

  /**
   * Override hook for tests: lets a spec swap in a capturing fake. Production
   * code lazy-imports `MetricsService` so this module stays importable without a
   * booted app (the service eagerly imports `@adonisjs/lucid/services/db`).
   */
  protected async getMetrics(): Promise<MetricsService> {
    const { default: MetricsServiceClass } = await import('../services/metrics_service.js')
    return new MetricsServiceClass()
  }

  async handle(ctx: HttpContext, next: NextFn, options: TrackMetricsOptions = {}) {
    if (this.isTestEnv() && (options.bypassInTestEnv ?? true)) {
      return next()
    }

    try {
      return await next()
    } finally {
      // Fail-open: a metrics backend error must never break the request, and the
      // downstream error (if any) still propagates out of the finally.
      try {
        await this.record(ctx, options)
      } catch {
        // swallow: recording is best-effort
      }
    }
  }

  protected async record(ctx: HttpContext, options: TrackMetricsOptions): Promise<void> {
    // Attribution: prefer the canonical id the guard already established
    // (`tenancy.currentId()`, always a validated tenant id), then the chain-aware
    // `resolveTenantIdSync` — the SAME authority routing uses — so a `resolverChain`
    // deployment records the row under the tenant actually served, not whatever
    // `resolverStrategy` alone resolves. The sync fallback re-reads a
    // client-controlled header/segment, so a non-`SAFE_IDENT` value there is forged
    // or injects `:` key structure. Drop it instead of letting it forge another
    // tenant's row in `backoffice.tenant_metrics`.
    const tenantId = this.currentTenantId() ?? resolveTenantIdSync(ctx.request)
    if (!tenantId || !isSafeIdentifier(tenantId)) return

    const metrics = await this.getMetrics()
    await metrics.increment(tenantId, 'requests')

    const threshold = options.errorThreshold ?? 500
    if (ctx.response.getStatus() >= threshold) {
      await metrics.increment(tenantId, 'errors')
    }

    const bytes = parseContentLength(ctx.response.getHeader('content-length'))
    if (bytes !== undefined) {
      await metrics.trackBandwidth(tenantId, bytes)
    }
  }
}

/**
 * Best-effort parse of a `Content-Length` header into a positive integer byte
 * count. Returns `undefined` when the header is absent (streamed responses) or
 * not a positive integer, so bandwidth is only tracked when it's trustworthy.
 */
function parseContentLength(header: unknown): number | undefined {
  if (header === undefined || header === null) return undefined
  const raw = Array.isArray(header) ? header[0] : header
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return undefined
  return n
}

import { tenancy } from '../tenancy.js'
import { boundedBatch } from '../concurrency.js'
import type { TenantModelContract } from '../types/contracts.js'

export interface MapTenantsOptions {
  /**
   * Peak tenants processed at once (default 10). Each one enters a `tenancy.run`
   * scope, which touches a tenant connection — keep this comfortably under
   * `config.isolation.maxTenantConnections` (default 50), leaving headroom for
   * request traffic, or you risk LRU eviction churn (or 503s under a hard cap).
   */
  concurrency?: number
  /**
   * `true` (default): a tenant whose `fn` throws is collected into `errors` and the
   * fan-out continues. `false`: the first failure rejects the whole call.
   */
  continueOnError?: boolean
}

export interface MapTenantsResult<T> {
  results: Array<{ tenantId: string; value: T }>
  errors: Array<{ tenantId: string; error: Error }>
}

/**
 * Run `fn` inside each tenant's schema scope with bounded concurrency and error
 * isolation — the safe primitive a report extension (or any host job) needs to
 * fan a query out across many tenants without hand-rolling `tenancy.run`,
 * batching, and per-tenant try/catch.
 *
 * Accepts tenant **models** (not ids) because `tenancy.run` needs the model; if
 * you have ids, resolve them first (e.g. via `resolveTenantRepository`). Returns
 * both the per-tenant results and the collected per-tenant errors, so one tenant
 * mid-migration never aborts the whole report.
 *
 * @example
 *   const { results, errors } = await mapTenants(tenants, async (t) => {
 *     // inside here, queries hit `t`'s schema
 *     return MyTenantModel.query().count('* as total')
 *   }, { concurrency: 5 })
 */
export async function mapTenants<T>(
  tenants: TenantModelContract[],
  fn: (tenant: TenantModelContract) => Promise<T>,
  options: MapTenantsOptions = {}
): Promise<MapTenantsResult<T>> {
  const { results, errors } = await boundedBatch(
    tenants,
    (tenant) => tenancy.run(tenant, () => fn(tenant)),
    {
      concurrency: options.concurrency ?? 10,
      continueOnError: options.continueOnError ?? true,
      keyOf: (tenant) => tenant.id,
    }
  )
  return {
    results: results.map((r) => ({ tenantId: r.key, value: r.value })),
    errors: errors.map((e) => ({ tenantId: e.key, error: e.error })),
  }
}

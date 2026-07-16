import { tenancy } from '../tenancy.js'
import { boundedBatch } from '../concurrency.js'
import type { TenantModelContract } from '../types/contracts.js'

/**
 * Options bag for the `mapTenants` fan-out helper, tuning how `fn` is run across
 * many tenant schema scopes. The optional `concurrency` field caps how many
 * tenants are processed at once (default 10), since each one opens a tenant
 * connection and should stay well under the configured connection ceiling. The
 * optional `continueOnError` field decides whether a tenant whose work throws is
 * collected into the result's `errors` array while the fan-out continues
 * (default true) or whether the first failure rejects the entire call.
 */
export interface MapTenantsOptions {
  /**
   * Peak tenants processed at once (default 10). Each one enters a `tenancy.run`
   * scope, which touches a tenant connection. Keep this comfortably under
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

/**
 * The outcome returned by `mapTenants` after fanning a function out across many
 * tenant schemas. It splits the per-tenant work into two parallel arrays: `results`
 * holds the successfully computed value for each tenant alongside its `tenantId`, and
 * `errors` collects the `tenantId` and thrown `Error` for any tenant whose function
 * failed, so a single failing tenant never discards the values gathered from the rest.
 *
 * @template T The value type produced per tenant by the mapped function.
 */
export interface MapTenantsResult<T> {
  results: Array<{ tenantId: string; value: T }>
  errors: Array<{ tenantId: string; error: Error }>
}

/**
 * Run `fn` inside each tenant's schema scope with bounded concurrency and error
 * isolation. This is the safe primitive a report extension (or any host job) needs to
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

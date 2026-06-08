import env from '../start/env.js'
import type { TenantResolverStrategy } from '@adonisjs-lasagna/saas-tenancy/types'

type BenchDriver = 'schema-pg' | 'database-pg' | 'rowscope-pg'

/**
 * The single knob that switches the whole stack between isolation strategies.
 * The provider reads `isolation.driver` and registers + activates the matching
 * driver, so flipping `BENCH_DRIVER` is all it takes to re-point the fixture at
 * schema-pg / database-pg / rowscope-pg.
 */
const driver = (process.env.BENCH_DRIVER ?? 'schema-pg') as BenchDriver

/** Resolver strategy, swappable so the HTTP tier can price header/path/subdomain. */
const resolverStrategy = (process.env.RESOLVER_STRATEGY ?? 'header') as TenantResolverStrategy

const num = (name: string, fallback: number): number => {
  const raw = process.env[name]
  const parsed = raw === undefined ? NaN : Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

export default {
  backofficeSchemaName: 'backoffice',
  backofficeConnectionName: 'backoffice',
  centralSchemaName: 'public',
  centralConnectionName: 'public',
  tenantConnectionNamePrefix: 'tenant_',
  tenantSchemaPrefix: 'tenant_',
  resolverStrategy,
  tenantHeaderKey: env.get('TENANT_HEADER_KEY'),
  baseDomain: 'localhost',
  schemaCacheTtl: 300,
  ignorePaths: ['/health', '/ceiling'],

  isolation: {
    driver,
    // The template connection that schema-pg/database-pg clone per tenant.
    // rowscope-pg ignores this — it shares `centralConnectionName` ('public')
    // since there is no per-tenant connection. `tenant` points at `public`, so
    // the same physical DB backs every driver under BENCH_DRIVER.
    templateConnectionName: 'tenant',
    // Sweepable so the churn + connection-budget tiers can vary the cap/grace.
    maxTenantConnections: num('BENCH_MAX_TENANT_CONNECTIONS', 50),
    evictionGracePeriodMs: num('BENCH_EVICTION_GRACE_MS', 30_000),
    // Only consulted for rowscope-pg. The shared notes table is scoped by
    // tenant_id; destroy() walks this list.
    rowScopeTables: ['notes'],
    rowScopeColumn: 'tenant_id',
  },

  cache: {
    ttl: 300,
    redis: {
      host: env.get('CACHE_REDIS_HOST'),
      port: env.get('CACHE_REDIS_PORT'),
      db: env.get('CACHE_REDIS_DB'),
    },
  },
}

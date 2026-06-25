import {
  IsolationDriverRegistry,
  SchemaPgDriver,
  TenantResolverRegistry,
  HeaderResolver,
  TenantAdapter,
  __configureTenancyForTests,
} from './internal.js'
import { runMicro, type BenchResult } from '../harness/runner.js'
import { FIXED_TENANT_ID } from './setup.js'

const GROUP = 'adapter_routing'

/**
 * Prices `TenantAdapter.modelConstructorClient` — the per-query routing call.
 * The warm path is seeded via `tenancy.currentId()` (the test-only injector
 * gives a fake log context returning a fixed UUID), so it runs the
 * `currentId → driver.connectionName → db.connection` branch with no HTTP
 * context and no app. The `db` is stubbed to return the connection name, so we
 * isolate the routing cost, not Lucid's connection lookup.
 */
export function runAdapterRouting(): BenchResult[] {
  const drivers = new IsolationDriverRegistry()
  drivers.register(new SchemaPgDriver(), { activate: true })

  const resolvers = new TenantResolverRegistry()
  resolvers.register(new HeaderResolver()).setChain(['header'])

  const db = { connection: (name: string) => name } as any
  const adapter = new TenantAdapter(db, drivers, resolvers)

  // Seed the active tenant id without an app or HTTP request.
  __configureTenancyForTests({ logCtx: { currentTenantId: () => FIXED_TENANT_ID } as any })

  const tenantCtor = {} as any // no static `connection` → routes by tenant id
  const explicitCtor = { connection: 'public' } as any // fast path baseline

  const results = [
    runMicro(
      'currentId → connectionName → db.connection',
      () => adapter.modelConstructorClient(tenantCtor),
      {
        group: GROUP,
      }
    ),
    runMicro(
      'explicit connection (fast path)',
      () => adapter.modelConstructorClient(explicitCtor),
      {
        group: GROUP,
      }
    ),
  ]

  // Reset so we don't leak the fake context into other tiers in this process.
  __configureTenancyForTests({})
  return results
}

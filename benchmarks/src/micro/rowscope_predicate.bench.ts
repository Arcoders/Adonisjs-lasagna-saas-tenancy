import { runMicro, type BenchResult } from '../harness/runner.js'
import { withTenantScope, __configureTenancyForTests } from './internal.js'
import { FIXED_TENANT_ID } from './setup.js'

const GROUP = 'rowscope_predicate'

class StubBuilder {
  where(): this {
    return this
  }
}

/**
 * Minimal Lucid-model stand-in: just the static surface `withTenantScope` boots
 * against (`before`, `boot`, `query`). Lets us price the scope-injection
 * overhead the mixin adds to `Model.query()` without a real ORM/connection.
 */
class StubBase {
  static booted = false
  static before(_event: string, _handler: (...args: any[]) => any): void {}
  static boot(): void {}
  static query(): StubBuilder {
    return new StubBuilder()
  }
}

/**
 * Prices the row-scope predicate injection: a scoped `query()` build (which
 * resolves the active tenant id and appends `where tenant_id = ?`) versus the
 * bare builder. The delta is the per-query cost the mixin adds for rowscope-pg.
 */
export function runRowscopePredicate(): BenchResult[] {
  const Scoped = withTenantScope(StubBase as any) as any
  Scoped.boot()

  __configureTenancyForTests({ logCtx: { currentTenantId: () => FIXED_TENANT_ID } as any })

  const results = [
    runMicro('scoped query() build', () => Scoped.query(), { group: GROUP }),
    runMicro('unscoped query() build (baseline)', () => StubBase.query(), { group: GROUP }),
  ]

  __configureTenancyForTests({})
  return results
}

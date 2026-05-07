import { test } from '@japa/runner'
import TenantLogContext from '../../../src/services/tenant_log_context.js'

interface FakeLogger {
  bindings: Record<string, unknown>
  child(b: Record<string, unknown>): FakeLogger
  trace(...a: any[]): void
  debug(...a: any[]): void
  info(...a: any[]): void
  warn(...a: any[]): void
  error(...a: any[]): void
  fatal(...a: any[]): void
}

function makeLogger(bindings: Record<string, unknown> = {}): FakeLogger {
  return {
    bindings,
    child(extra) {
      return makeLogger({ ...bindings, ...extra })
    },
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
  }
}

test.group('TenantLogContext — outside a run scope', () => {
  test('current() returns undefined', ({ assert }) => {
    const ctx = new TenantLogContext()
    assert.isUndefined(ctx.current())
  })

  test('currentTenantId() returns undefined', ({ assert }) => {
    const ctx = new TenantLogContext()
    assert.isUndefined(ctx.currentTenantId())
  })

  test('bind() returns the original logger unchanged', ({ assert }) => {
    const ctx = new TenantLogContext()
    const base = makeLogger()
    const bound = ctx.bind(base)
    assert.strictEqual(bound, base)
  })
})

test.group('TenantLogContext — inside run()', () => {
  test('current() returns the active context', async ({ assert }) => {
    const ctx = new TenantLogContext()
    await ctx.run({ tenantId: 'abc' }, async () => {
      assert.deepEqual(ctx.current(), { tenantId: 'abc' })
    })
  })

  test('currentTenantId() returns the active tenant id', async ({ assert }) => {
    const ctx = new TenantLogContext()
    await ctx.run({ tenantId: 'tenant-42' }, async () => {
      assert.equal(ctx.currentTenantId(), 'tenant-42')
    })
  })

  test('bind() returns a child logger with tenantId bindings', async ({ assert }) => {
    const ctx = new TenantLogContext()
    const base = makeLogger({ app: 'multitenancy' })
    await ctx.run({ tenantId: 'xyz' }, async () => {
      const bound = ctx.bind(base) as unknown as FakeLogger
      assert.deepEqual(bound.bindings, { app: 'multitenancy', tenantId: 'xyz' })
    })
  })

  test('extra arbitrary fields propagate via bind()', async ({ assert }) => {
    const ctx = new TenantLogContext()
    const base = makeLogger()
    await ctx.run({ tenantId: 'a', requestId: 'r-1' }, async () => {
      const bound = ctx.bind(base) as unknown as FakeLogger
      assert.deepEqual(bound.bindings, { tenantId: 'a', requestId: 'r-1' })
    })
  })

  test('async continuations within run() see the same context', async ({ assert }) => {
    const ctx = new TenantLogContext()
    await ctx.run({ tenantId: 'a' }, async () => {
      await new Promise((r) => setTimeout(r, 5))
      await Promise.resolve()
      assert.equal(ctx.currentTenantId(), 'a')
    })
  })

  test('nested run() shadows parent within its scope and restores after', async ({ assert }) => {
    const ctx = new TenantLogContext()
    await ctx.run({ tenantId: 'outer' }, async () => {
      assert.equal(ctx.currentTenantId(), 'outer')
      await ctx.run({ tenantId: 'inner' }, async () => {
        assert.equal(ctx.currentTenantId(), 'inner')
      })
      assert.equal(ctx.currentTenantId(), 'outer')
    })
  })

  test('parallel run() scopes do not leak into each other', async ({ assert }) => {
    const ctx = new TenantLogContext()
    const results: string[] = []

    async function task(id: string) {
      await ctx.run({ tenantId: id }, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 10))
        results.push(`${id}:${ctx.currentTenantId()}`)
      })
    }

    await Promise.all([task('alpha'), task('beta'), task('gamma')])

    for (const r of results) {
      const [id, observed] = r.split(':')
      assert.equal(observed, id, `${r} should observe its own tenantId`)
    }
  })

  test('after run() returns, context is cleared', async ({ assert }) => {
    const ctx = new TenantLogContext()
    await ctx.run({ tenantId: 'gone' }, async () => {})
    assert.isUndefined(ctx.currentTenantId())
  })
})

import { test } from '@japa/runner'
import { tenancy, __configureTenancyForTests } from '../../../src/tenancy.js'
import BootstrapperRegistry from '../../../src/services/bootstrapper_registry.js'
import TenantLogContext from '../../../src/services/tenant_log_context.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = (id = 'tenant-1') =>
  ({ id, name: `tenant-${id}` }) as unknown as TenantModelContract

function setup(): { logCtx: TenantLogContext; registry: BootstrapperRegistry } {
  const logCtx = new TenantLogContext()
  const registry = new BootstrapperRegistry()
  __configureTenancyForTests({ logCtx, registry })
  return { logCtx, registry }
}

test.group('tenancy.run — context propagation', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  test('binds tenantId to AsyncLocalStorage inside fn', async ({ assert }) => {
    const { logCtx } = setup()
    let observed: string | undefined
    await tenancy.run(fakeTenant('abc'), async () => {
      observed = logCtx.currentTenantId()
    })
    assert.equal(observed, 'abc')
  })

  test('returns the value produced by fn', async ({ assert }) => {
    setup()
    const result = await tenancy.run(fakeTenant(), () => 7 * 6)
    assert.equal(result, 42)
  })

  test('currentId() reflects active scope and clears afterwards', async ({ assert }) => {
    setup()
    await tenancy.run(fakeTenant('inside'), async () => {
      assert.equal(tenancy.currentId(), 'inside')
    })
    assert.isUndefined(tenancy.currentId())
  })

  test('parallel runs do not leak tenantId between scopes', async ({ assert }) => {
    setup()
    const seen: string[] = []
    async function task(id: string) {
      await tenancy.run(fakeTenant(id), async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 8))
        seen.push(`${id}:${tenancy.currentId()}`)
      })
    }
    await Promise.all([task('alpha'), task('beta'), task('gamma')])
    for (const entry of seen) {
      const [id, observed] = entry.split(':')
      assert.equal(observed, id)
    }
  })
})

test.group('tenancy.run — bootstrapper integration', (group) => {
  group.each.teardown(() => __configureTenancyForTests({}))

  test('runs registered bootstrappers around fn', async ({ assert }) => {
    const { registry } = setup()
    const log: string[] = []
    registry.register({
      name: 'cache',
      enter: (ctx) => {
        log.push(`enter:cache:${ctx.tenant.id}`)
      },
      leave: (ctx) => {
        log.push(`leave:cache:${ctx.tenant.id}`)
      },
    })
    registry.register({
      name: 'queue',
      enter: () => {
        log.push('enter:queue')
      },
      leave: () => {
        log.push('leave:queue')
      },
    })

    await tenancy.run(fakeTenant('xyz'), () => {
      log.push('fn')
    })

    assert.deepEqual(log, [
      'enter:cache:xyz',
      'enter:queue',
      'fn',
      'leave:queue',
      'leave:cache:xyz',
    ])
  })

  test('still runs leave when fn throws, and propagates the error', async ({ assert }) => {
    const { registry } = setup()
    const log: string[] = []
    registry.register({
      name: 'a',
      enter: () => {
        log.push('enter:a')
      },
      leave: () => {
        log.push('leave:a')
      },
    })

    await assert.rejects(
      () =>
        tenancy.run(fakeTenant(), () => {
          log.push('fn')
          throw new Error('boom')
        }),
      /boom/
    )
    assert.deepEqual(log, ['enter:a', 'fn', 'leave:a'])
  })
})

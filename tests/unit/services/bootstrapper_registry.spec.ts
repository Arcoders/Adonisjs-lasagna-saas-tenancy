import { test } from '@japa/runner'
import BootstrapperRegistry, {
  type BootstrapperContext,
  type TenantBootstrapper,
} from '../../../src/services/bootstrapper_registry.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = { id: 'tenant-1', name: 'Acme' } as unknown as TenantModelContract
const ctx = (): BootstrapperContext => ({ tenant: fakeTenant })

function makeBootstrapper(
  name: string,
  log: string[],
  opts: { failEnter?: boolean; failLeave?: boolean; skipLeave?: boolean } = {}
): TenantBootstrapper {
  return {
    name,
    async enter() {
      log.push(`enter:${name}`)
      if (opts.failEnter) throw new Error(`enter:${name}:boom`)
    },
    leave: opts.skipLeave
      ? undefined
      : async () => {
          log.push(`leave:${name}`)
          if (opts.failLeave) throw new Error(`leave:${name}:boom`)
        },
  }
}

test.group('BootstrapperRegistry — registration', () => {
  test('register adds a bootstrapper and tracks order', ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('cache', log))
    reg.register(makeBootstrapper('queue', log))

    assert.deepEqual(reg.list(), ['cache', 'queue'])
    assert.isTrue(reg.has('cache'))
    assert.isFalse(reg.has('mail'))
  })

  test('register throws on duplicate name', ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('cache', log))
    assert.throws(
      () => reg.register(makeBootstrapper('cache', log)),
      /already registered/
    )
  })

  test('unregister removes the bootstrapper and returns true', ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('cache', log))

    assert.isTrue(reg.unregister('cache'))
    assert.isFalse(reg.has('cache'))
    assert.deepEqual(reg.list(), [])
  })

  test('unregister returns false when name is unknown', ({ assert }) => {
    const reg = new BootstrapperRegistry()
    assert.isFalse(reg.unregister('missing'))
  })

  test('clear empties the registry', ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log))
    reg.clear()
    assert.deepEqual(reg.list(), [])
  })
})

test.group('BootstrapperRegistry — runEnter / runLeave ordering', () => {
  test('runEnter executes in registration order, runLeave in reverse', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log))
    reg.register(makeBootstrapper('c', log))

    await reg.runEnter(ctx())
    await reg.runLeave(ctx())

    assert.deepEqual(log, [
      'enter:a',
      'enter:b',
      'enter:c',
      'leave:c',
      'leave:b',
      'leave:a',
    ])
  })

  test('runEnter awaits sequentially', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const order: number[] = []
    let i = 0
    for (const name of ['a', 'b', 'c']) {
      reg.register({
        name,
        async enter() {
          const me = ++i
          await new Promise((r) => setTimeout(r, 5))
          order.push(me)
        },
      })
    }
    await reg.runEnter(ctx())
    assert.deepEqual(order, [1, 2, 3])
  })

  test('runLeave skips bootstrappers without leave()', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log, { skipLeave: true }))
    reg.register(makeBootstrapper('c', log))

    await reg.runEnter(ctx())
    log.length = 0
    await reg.runLeave(ctx())

    assert.deepEqual(log, ['leave:c', 'leave:a'])
  })
})

test.group('BootstrapperRegistry — error handling', () => {
  test('runEnter propagates errors and stops the chain', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log, { failEnter: true }))
    reg.register(makeBootstrapper('c', log))

    await assert.rejects(() => reg.runEnter(ctx()), /enter:b:boom/)
    assert.deepEqual(log, ['enter:a', 'enter:b'])
  })

  test('runLeave swallows errors and continues teardown', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log, { failLeave: true }))
    reg.register(makeBootstrapper('c', log))

    await reg.runEnter(ctx())
    log.length = 0
    await assert.doesNotReject(() => reg.runLeave(ctx()))

    assert.deepEqual(log, ['leave:c', 'leave:b', 'leave:a'])
  })
})

test.group('BootstrapperRegistry — runScoped atomicity', () => {
  test('runScoped runs enter, fn, then leave in correct order', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log))

    const result = await reg.runScoped(ctx(), () => {
      log.push('fn')
      return 42
    })

    assert.equal(result, 42)
    assert.deepEqual(log, ['enter:a', 'enter:b', 'fn', 'leave:b', 'leave:a'])
  })

  test('runScoped runs leave even when fn throws', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log))

    await assert.rejects(
      () =>
        reg.runScoped(ctx(), () => {
          log.push('fn')
          throw new Error('boom')
        }),
      /boom/
    )

    assert.deepEqual(log, ['enter:a', 'enter:b', 'fn', 'leave:b', 'leave:a'])
  })

  test('runScoped unwinds partial enter on enter failure', async ({ assert }) => {
    const reg = new BootstrapperRegistry()
    const log: string[] = []
    reg.register(makeBootstrapper('a', log))
    reg.register(makeBootstrapper('b', log, { failEnter: true }))
    reg.register(makeBootstrapper('c', log))

    let fnCalled = false
    await assert.rejects(
      () =>
        reg.runScoped(ctx(), () => {
          fnCalled = true
        }),
      /enter:b:boom/
    )

    assert.isFalse(fnCalled)
    // 'a' entered → leaves; 'b' threw before completion → no leave for b; 'c' never entered
    assert.deepEqual(log, ['enter:a', 'enter:b', 'leave:a'])
  })
})

import { test } from '@japa/runner'
import HookRegistry from '../../../src/services/hook_registry.js'
import type { TenantModelContract } from '../../../src/types/contracts.js'

const fakeTenant = { id: 'tenant-1', name: 'Acme' } as unknown as TenantModelContract

test.group('HookRegistry — registration and execution', () => {
  test('runs no-op when no hooks are registered', async ({ assert }) => {
    const reg = new HookRegistry()
    await assert.doesNotReject(() => reg.run('before', 'provision', { tenant: fakeTenant }))
  })

  test('before hook runs and receives the context', async ({ assert }) => {
    const reg = new HookRegistry()
    let received: TenantModelContract | null = null
    reg.before('provision', (ctx) => {
      received = ctx.tenant
    })

    await reg.run('before', 'provision', { tenant: fakeTenant })
    assert.strictEqual(received, fakeTenant)
  })

  test('after hook runs and receives the context', async ({ assert }) => {
    const reg = new HookRegistry()
    let received: TenantModelContract | null = null
    reg.after('destroy', (ctx) => {
      received = ctx.tenant
    })

    await reg.run('after', 'destroy', { tenant: fakeTenant })
    assert.strictEqual(received, fakeTenant)
  })

  test('multiple hooks for same phase+event run in registration order', async ({ assert }) => {
    const reg = new HookRegistry()
    const order: number[] = []
    reg.before('backup', () => {
      order.push(1)
    })
    reg.before('backup', () => {
      order.push(2)
    })
    reg.before('backup', () => {
      order.push(3)
    })

    await reg.run('before', 'backup', { tenant: fakeTenant })
    assert.deepEqual(order, [1, 2, 3])
  })

  test('hooks are isolated per phase and event', async ({ assert }) => {
    const reg = new HookRegistry()
    let beforeCalls = 0
    let afterCalls = 0
    let migrateCalls = 0

    reg.before('provision', () => {
      beforeCalls++
    })
    reg.after('provision', () => {
      afterCalls++
    })
    reg.before('migrate', () => {
      migrateCalls++
    })

    await reg.run('before', 'provision', { tenant: fakeTenant })
    assert.equal(beforeCalls, 1)
    assert.equal(afterCalls, 0)
    assert.equal(migrateCalls, 0)

    await reg.run('after', 'provision', { tenant: fakeTenant })
    assert.equal(afterCalls, 1)
    assert.equal(migrateCalls, 0)
  })

  test('async hooks are awaited in series', async ({ assert }) => {
    const reg = new HookRegistry()
    const order: string[] = []

    reg.before('clone', async () => {
      await new Promise((r) => setTimeout(r, 10))
      order.push('first')
    })
    reg.before('clone', () => {
      order.push('second')
    })

    await reg.run('before', 'clone', {
      source: fakeTenant,
      destination: fakeTenant,
    })
    assert.deepEqual(order, ['first', 'second'])
  })
})

test.group('HookRegistry — error semantics', () => {
  test('before hook throwing aborts the run with same error', async ({ assert }) => {
    const reg = new HookRegistry()
    reg.before('provision', () => {
      throw new Error('boom')
    })

    await assert.rejects(
      () => reg.run('before', 'provision', { tenant: fakeTenant }),
      'boom'
    )
  })

  test('subsequent before hooks do not run after a thrown one', async ({ assert }) => {
    const reg = new HookRegistry()
    let secondCalled = false

    reg.before('provision', () => {
      throw new Error('stop')
    })
    reg.before('provision', () => {
      secondCalled = true
    })

    await assert.rejects(() => reg.run('before', 'provision', { tenant: fakeTenant }))
    assert.isFalse(secondCalled)
  })

  test('after hook throwing does NOT abort and subsequent hooks still run', async ({ assert }) => {
    const reg = new HookRegistry()
    let secondCalled = false

    reg.after('backup', () => {
      throw new Error('after-failure')
    })
    reg.after('backup', () => {
      secondCalled = true
    })

    await assert.doesNotReject(() => reg.run('after', 'backup', { tenant: fakeTenant }))
    assert.isTrue(secondCalled)
  })
})

test.group('HookRegistry — declarative hooks loading', () => {
  test('loadDeclarative wires up all 12 hooks correctly', async ({ assert }) => {
    const reg = new HookRegistry()
    const calls: string[] = []

    reg.loadDeclarative({
      beforeProvision: () => {
        calls.push('beforeProvision')
      },
      afterProvision: () => {
        calls.push('afterProvision')
      },
      beforeDestroy: () => {
        calls.push('beforeDestroy')
      },
      afterDestroy: () => {
        calls.push('afterDestroy')
      },
      beforeBackup: () => {
        calls.push('beforeBackup')
      },
      afterBackup: () => {
        calls.push('afterBackup')
      },
      beforeRestore: () => {
        calls.push('beforeRestore')
      },
      afterRestore: () => {
        calls.push('afterRestore')
      },
      beforeClone: () => {
        calls.push('beforeClone')
      },
      afterClone: () => {
        calls.push('afterClone')
      },
      beforeMigrate: () => {
        calls.push('beforeMigrate')
      },
      afterMigrate: () => {
        calls.push('afterMigrate')
      },
    })

    await reg.run('before', 'provision', { tenant: fakeTenant })
    await reg.run('after', 'provision', { tenant: fakeTenant })
    await reg.run('before', 'destroy', { tenant: fakeTenant })
    await reg.run('after', 'destroy', { tenant: fakeTenant })
    await reg.run('before', 'backup', { tenant: fakeTenant })
    await reg.run('after', 'backup', { tenant: fakeTenant })
    await reg.run('before', 'restore', { tenant: fakeTenant, fileName: 'x.dump' })
    await reg.run('after', 'restore', { tenant: fakeTenant, fileName: 'x.dump' })
    await reg.run('before', 'clone', { source: fakeTenant, destination: fakeTenant })
    await reg.run('after', 'clone', { source: fakeTenant, destination: fakeTenant })
    await reg.run('before', 'migrate', { tenant: fakeTenant, direction: 'up' })
    await reg.run('after', 'migrate', { tenant: fakeTenant, direction: 'up' })

    assert.deepEqual(calls, [
      'beforeProvision',
      'afterProvision',
      'beforeDestroy',
      'afterDestroy',
      'beforeBackup',
      'afterBackup',
      'beforeRestore',
      'afterRestore',
      'beforeClone',
      'afterClone',
      'beforeMigrate',
      'afterMigrate',
    ])
  })

  test('loadDeclarative with undefined is a no-op', async ({ assert }) => {
    const reg = new HookRegistry()
    reg.loadDeclarative(undefined)
    await assert.doesNotReject(() => reg.run('before', 'provision', { tenant: fakeTenant }))
  })

  test('loadDeclarative composes additively with imperative hooks', async ({ assert }) => {
    const reg = new HookRegistry()
    const order: string[] = []

    reg.before('provision', () => {
      order.push('imperative')
    })
    reg.loadDeclarative({
      beforeProvision: () => {
        order.push('declarative')
      },
    })

    await reg.run('before', 'provision', { tenant: fakeTenant })
    assert.deepEqual(order, ['imperative', 'declarative'])
  })
})

test.group('HookRegistry — clear', () => {
  test('clear removes all registered hooks', async ({ assert }) => {
    const reg = new HookRegistry()
    let called = false
    reg.before('provision', () => {
      called = true
    })

    reg.clear()
    await reg.run('before', 'provision', { tenant: fakeTenant })

    assert.isFalse(called)
  })
})

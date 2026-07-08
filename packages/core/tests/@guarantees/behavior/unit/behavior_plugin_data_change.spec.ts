import { test } from '@japa/runner'
import { subscribeDataChange } from '../../../../src/services/plugin_data_change.js'
import type {
  TenantDataChangePayload,
  TenantDataChangeSubscription,
} from '../../../../src/events/tenant_data_changed.js'
import type { ApplicationService } from '@adonisjs/core/types'

/**
 * The onDataChange subscription wiring (SEAM-5). It applies the declared
 * model/operation filters and runs each handler FAIL-OPEN: a throwing subscriber is
 * caught (never propagated back through the emitter to the write path), so one bad
 * plugin can't break another's handler or the write. Tested with a fake emitter, so
 * no booted app / Redis is needed.
 */

/** A fake app whose container.make('emitter') returns a recording emitter. */
function fakeApp() {
  const listeners: Array<(event: { change: TenantDataChangePayload }) => Promise<void>> = []
  const emitter = {
    on: (
      _event: unknown,
      listener: (event: { change: TenantDataChangePayload }) => Promise<void>
    ) => {
      listeners.push(listener)
    },
  }
  const app = {
    container: { make: async (binding: string) => (binding === 'emitter' ? emitter : null) },
  } as unknown as ApplicationService
  return { app, listeners }
}

const change = (over: Partial<TenantDataChangePayload> = {}): TenantDataChangePayload => ({
  tenantId: 'tenant-a',
  model: 'Order',
  table: 'orders',
  operation: 'create',
  keys: { id: 1 },
  ...over,
})

test.group('subscribeDataChange', () => {
  test('registers one listener per subscription', async ({ assert }) => {
    const { app, listeners } = fakeApp()
    await subscribeDataChange(app, 'search', [{ handle: () => {} }, { handle: () => {} }])
    assert.lengthOf(listeners, 2)
  })

  test('does nothing for an empty subscription list', async ({ assert }) => {
    const { app, listeners } = fakeApp()
    await subscribeDataChange(app, 'search', [])
    assert.lengthOf(listeners, 0)
  })

  test('filters by model AND operation (AND-combined)', async ({ assert }) => {
    const { app, listeners } = fakeApp()
    const seen: TenantDataChangePayload[] = []
    const sub: TenantDataChangeSubscription = {
      models: ['Order'],
      operations: ['update'],
      handle: (c) => {
        seen.push(c)
      },
    }
    await subscribeDataChange(app, 'search', [sub])
    const listener = listeners[0]
    await listener({ change: change({ model: 'User', operation: 'update' }) }) // wrong model
    await listener({ change: change({ model: 'Order', operation: 'create' }) }) // wrong op
    await listener({ change: change({ model: 'Order', operation: 'update' }) }) // match
    assert.lengthOf(seen, 1)
    assert.equal(seen[0].model, 'Order')
    assert.equal(seen[0].operation, 'update')
  })

  test('no filters → receives every change', async ({ assert }) => {
    const { app, listeners } = fakeApp()
    let count = 0
    await subscribeDataChange(app, 'search', [{ handle: () => void count++ }])
    await listeners[0]({ change: change({ model: 'A' }) })
    await listeners[0]({ change: change({ model: 'B', operation: 'delete' }) })
    assert.equal(count, 2)
  })

  test('FAIL-OPEN: a throwing subscriber is caught, not propagated', async ({ assert }) => {
    const { app, listeners } = fakeApp()
    await subscribeDataChange(app, 'search', [
      {
        handle: () => {
          throw new Error('subscriber boom')
        },
      },
    ])
    // The listener must resolve (the failure is logged + counted, never rethrown to
    // the emitter / write path). No Redis here, so the failure-metric emit itself
    // fails and is swallowed with a warn — still must not reject.
    await assert.doesNotReject(() => listeners[0]({ change: change() }))
  })

  test('fan-out isolation: one failing subscriber does not stop a healthy one', async ({
    assert,
  }) => {
    const { app, listeners } = fakeApp()
    let healthyRan = false
    await subscribeDataChange(app, 'search', [
      {
        handle: () => {
          throw new Error('plugin A boom')
        },
      },
      {
        handle: () => {
          healthyRan = true
        },
      },
    ])
    // Each subscription is its own listener; the emitter fans out to both. The
    // failing one is isolated in its own try/catch, so the healthy one still runs.
    await assert.doesNotReject(() => listeners[0]({ change: change() }))
    await listeners[1]({ change: change() })
    assert.isTrue(healthyRan, "the healthy subscriber ran despite plugin A's failure")
  })
})

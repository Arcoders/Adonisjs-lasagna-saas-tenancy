import { test } from '@japa/runner'
import {
  TracksDataChanges,
  __setDataChangeDispatcherForTests,
} from '../../../../src/models/mixins/tracks_data_changes.js'
import TenantLogContext from '../../../../src/services/tenant_log_context.js'
import { primeTenancy, __configureTenancyForTests } from '../../../../src/tenancy.js'
import type { TenantDataChangePayload } from '../../../../src/events/tenant_data_changed.js'

/**
 * The data-change mixin (SEAM-5). Guarantees under test — all provable without a
 * booted app via the dispatcher + tenancy test seams:
 *  - ISOLATION: a change is attributed to `tenancy.currentId()` and SKIPPED when
 *    there is no scope (never emitted mis-attributed); the payload names WHAT
 *    changed (model/table/pk/changed columns), never the values.
 *  - AFTER-COMMIT: with a transaction, the emit is deferred to `commit` — a write
 *    that ROLLS BACK (commit never fires) emits nothing; an autocommit write
 *    (no `$trx`) emits inline.
 */

/** A fake Lucid base that records the mixin's registered hooks so a test can fire them. */
function fakeBase() {
  const hooks: Record<string, Array<(m: any) => void>> = {}
  class FakeBase {
    static booted = false
    static boot(): void {
      this.booted = true
    }
    static before(event: string, handler: (m: any) => void): void {
      ;(hooks[`before:${event}`] ??= []).push(handler)
    }
    static after(event: string, handler: (m: any) => void): void {
      ;(hooks[`after:${event}`] ??= []).push(handler)
    }
  }
  const Tracked = TracksDataChanges(FakeBase as any) as unknown as typeof FakeBase
  Tracked.boot()
  const fire = (key: string, model: any) => (hooks[key] ?? []).forEach((h) => h(model))
  return { fire }
}

/** A fake model with an optional transaction that captures its commit callbacks. */
function fakeModel(overrides: Record<string, unknown> = {}, withTrx = true) {
  const commitCbs: Array<() => void> = []
  const model: any = {
    id: 7,
    constructor: { name: 'Order', table: 'orders', primaryKey: 'id' },
    ...overrides,
  }
  if (withTrx) {
    model.$trx = {
      after: (event: string, cb: () => void) => event === 'commit' && commitCbs.push(cb),
    }
  }
  return { model, commit: () => commitCbs.forEach((cb) => cb()) }
}

test.group('TracksDataChanges mixin', (group) => {
  let logCtx: TenantLogContext
  let restore: (() => void) | undefined
  let captured: TenantDataChangePayload[]

  group.each.setup(() => {
    logCtx = new TenantLogContext()
    primeTenancy(logCtx)
    captured = []
    restore = __setDataChangeDispatcherForTests((p) => {
      captured.push(p)
    })
  })
  group.each.teardown(() => {
    restore?.()
    __configureTenancyForTests()
  })

  const inScope = (tenantId: string, fn: () => void) => logCtx.run({ tenantId }, async () => fn())

  test('create: emits AFTER commit with a names-only payload', async ({ assert }) => {
    const { fire } = fakeBase()
    const { model, commit } = fakeModel()
    await inScope('tenant-a', () => fire('after:create', model))
    assert.lengthOf(captured, 0, 'nothing emitted before commit')
    commit()
    assert.lengthOf(captured, 1)
    assert.deepEqual(captured[0], {
      tenantId: 'tenant-a',
      model: 'Order',
      table: 'orders',
      operation: 'create',
      keys: { id: 7 },
    })
  })

  test('a rolled-back write (commit never fires) emits nothing', async ({ assert }) => {
    const { fire } = fakeBase()
    const { model } = fakeModel()
    await inScope('tenant-a', () => fire('after:create', model))
    // commit() is never called → rollback → no emit
    assert.lengthOf(captured, 0)
  })

  test('autocommit (no $trx) emits inline', async ({ assert }) => {
    const { fire } = fakeBase()
    const { model } = fakeModel({}, false)
    await inScope('tenant-a', () => fire('after:create', model))
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.operation, 'create')
  })

  test('NO tenant scope → skipped (never emitted mis-attributed)', async ({ assert }) => {
    const { fire } = fakeBase()
    const { model, commit } = fakeModel()
    // fire OUTSIDE logCtx.run → currentId() is undefined
    fire('after:create', model)
    commit()
    assert.lengthOf(captured, 0)
  })

  test('update: carries the changed COLUMN NAMES (never values)', async ({ assert }) => {
    const { fire } = fakeBase()
    const { model, commit } = fakeModel({ $dirty: { total: 1299, status: 'paid' } })
    await inScope('tenant-b', () => {
      fire('before:update', model) // snapshots $dirty column names
      fire('after:update', model)
    })
    commit()
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.operation, 'update')
    assert.deepEqual(captured[0]!.columns, ['total', 'status'])
    // the payload never carries the VALUES
    assert.notProperty(captured[0], 'values')
  })

  test('delete: pk-only payload, no columns', async ({ assert }) => {
    const { fire } = fakeBase()
    const { model, commit } = fakeModel()
    await inScope('tenant-a', () => fire('after:delete', model))
    commit()
    assert.equal(captured[0]!.operation, 'delete')
    assert.isUndefined(captured[0]!.columns)
    assert.deepEqual(captured[0]!.keys, { id: 7 })
  })
})

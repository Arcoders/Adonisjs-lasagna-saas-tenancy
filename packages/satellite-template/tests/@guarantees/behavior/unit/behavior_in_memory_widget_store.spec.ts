import { test } from '@japa/runner'
import InMemoryWidgetStore from '../../../../src/testing/in_memory_widget_store.js'

test.group('InMemoryWidgetStore (satellite template)', () => {
  test('create assigns a deterministic id and defaults enabled', async ({ assert }) => {
    const store = new InMemoryWidgetStore()
    const w = await store.create({ tenantId: 't1', name: 'alpha' })
    assert.equal(w.id, 'w_1')
    assert.equal(w.tenantId, 't1')
    assert.isTrue(w.enabled)
  })

  test("listForTenant only returns the tenant's widgets", async ({ assert }) => {
    const store = new InMemoryWidgetStore()
    await store.create({ tenantId: 't1', name: 'alpha' })
    await store.create({ tenantId: 't2', name: 'beta' })
    const t1 = await store.listForTenant('t1')
    assert.lengthOf(t1, 1)
    assert.equal(t1[0]?.name, 'alpha')
  })

  test('setEnabled patches and get reflects it', async ({ assert }) => {
    const store = new InMemoryWidgetStore()
    const w = await store.create({ tenantId: 't1', name: 'alpha' })
    await store.setEnabled(w.id, false)
    const got = await store.get(w.id)
    assert.isFalse(got?.enabled)
  })

  test('setEnabled on a missing id returns null', async ({ assert }) => {
    const store = new InMemoryWidgetStore()
    assert.isNull(await store.setEnabled('nope', true))
  })

  test('deleteForTenant removes every matching widget and returns the count', async ({
    assert,
  }) => {
    const store = new InMemoryWidgetStore()
    await store.create({ tenantId: 't1', name: 'a' })
    await store.create({ tenantId: 't1', name: 'b' })
    await store.create({ tenantId: 't2', name: 'c' })
    const removed = await store.deleteForTenant('t1')
    assert.equal(removed, 2)
    assert.lengthOf(await store.listForTenant('t1'), 0)
    assert.lengthOf(await store.listForTenant('t2'), 1)
  })
})

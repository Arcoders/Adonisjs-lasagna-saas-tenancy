import { test } from '@japa/runner'
import InMemoryStore from '../../src/testing/in_memory_store.js'

interface Row {
  id: string
  name: string
  enabled: boolean
}

test.group('InMemoryStore (template copyable helper)', () => {
  test('insert stores a clone; mutating the input or result does not leak', ({ assert }) => {
    const store = new InMemoryStore<Row>()
    const input: Row = { id: 'a', name: 'alpha', enabled: true }
    const inserted = store.insert(input)
    input.name = 'mutated-input'
    inserted.name = 'mutated-result'
    assert.equal(store.get('a')?.name, 'alpha')
  })

  test('insert throws on a duplicate id', ({ assert }) => {
    const store = new InMemoryStore<Row>()
    store.insert({ id: 'a', name: 'alpha', enabled: true })
    assert.throws(() => store.insert({ id: 'a', name: 'beta', enabled: true }))
  })

  test('get returns null for an unknown id', ({ assert }) => {
    assert.isNull(new InMemoryStore<Row>().get('nope'))
  })

  test('filter returns only matching clones', ({ assert }) => {
    const store = new InMemoryStore<Row>()
    store.insert({ id: 'a', name: 'alpha', enabled: true })
    store.insert({ id: 'b', name: 'beta', enabled: false })
    const enabled = store.filter((r) => r.enabled)
    assert.deepEqual(
      enabled.map((r) => r.id),
      ['a']
    )
  })

  test('update merges, keeps the id immutable, and returns null on a missing id', ({ assert }) => {
    const store = new InMemoryStore<Row>()
    store.insert({ id: 'a', name: 'alpha', enabled: true })
    const updated = store.update('a', { enabled: false })
    assert.equal(updated?.id, 'a')
    assert.equal(updated?.name, 'alpha')
    assert.isFalse(updated?.enabled)
    assert.isNull(store.update('missing', { enabled: true }))
  })

  test('delete returns whether anything was removed', ({ assert }) => {
    const store = new InMemoryStore<Row>()
    store.insert({ id: 'a', name: 'alpha', enabled: true })
    assert.isTrue(store.delete('a'))
    assert.isFalse(store.delete('a'))
    assert.isNull(store.get('a'))
  })

  test('seq is deterministic and prefix-aware', ({ assert }) => {
    const store = new InMemoryStore<Row>()
    assert.equal(store.seq('w_'), 'w_1')
    assert.equal(store.seq('w_'), 'w_2')
    assert.equal(store.seq(), '3')
  })
})

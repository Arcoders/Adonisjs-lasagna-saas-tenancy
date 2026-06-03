import { test } from '@japa/runner'
import IsolationDriverRegistry from '../../../src/services/isolation/registry.js'
import type {
  IsolationDriver,
  IsolationDriverName,
} from '../../../src/services/isolation/driver.js'

function fakeDriver(name: IsolationDriverName | string): IsolationDriver {
  return {
    name: name as IsolationDriverName,
    async provision() {},
    async destroy() {},
    async reset() {},
    async connect() {
      return {} as any
    },
    async disconnect() {},
    connectionName() {
      return `conn:${name}`
    },
    async migrate() {
      return { executed: 0 }
    },
  }
}

test.group('IsolationDriverRegistry — registration', () => {
  test('register adds a driver and activates the first one by default', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))

    assert.deepEqual(reg.list(), ['schema-pg'])
    assert.isTrue(reg.has('schema-pg'))
    assert.equal(reg.active().name, 'schema-pg')
  })

  test('register does not switch active when more drivers are added', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))
    reg.register(fakeDriver('database-pg'))

    assert.equal(reg.active().name, 'schema-pg')
    assert.deepEqual(reg.list(), ['schema-pg', 'database-pg'])
  })

  test('register with { activate: true } switches the active driver', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))
    reg.register(fakeDriver('database-pg'), { activate: true })

    assert.equal(reg.active().name, 'database-pg')
  })

  test('use() switches the active driver to a registered one', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))
    reg.register(fakeDriver('rowscope-pg'))

    reg.use('rowscope-pg')
    assert.equal(reg.active().name, 'rowscope-pg')
  })

  test('use() throws when the driver is not registered', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))

    assert.throws(() => reg.use('database-pg'), /not registered/)
  })

  test('active() throws when no driver has been registered', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    assert.throws(() => reg.active(), /no active driver/)
  })

  test('clear() resets registrations and clears the active driver', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))
    reg.clear()

    assert.deepEqual(reg.list(), [])
    assert.throws(() => reg.active(), /no active driver/)
  })

  test('get() returns a driver by name without activating it', ({ assert }) => {
    const reg = new IsolationDriverRegistry()
    reg.register(fakeDriver('schema-pg'))
    reg.register(fakeDriver('database-pg'))

    const d = reg.get('database-pg')
    assert.exists(d)
    assert.equal(d!.name, 'database-pg')
    // active is unchanged
    assert.equal(reg.active().name, 'schema-pg')
  })
})

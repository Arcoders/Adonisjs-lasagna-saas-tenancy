import { test } from '@japa/runner'
import { assertConfiguredDriverRegistered } from '../../../../src/services/isolation/validate_driver_choice.js'
import IsolationConfigException from '../../../../src/exceptions/isolation_config_exception.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'
import type { IsolationDriver } from '../../../../src/services/isolation/driver.js'

/**
 * `IsolationDriverChoice` is an open union (custom drivers), so a typo in
 * `config.isolation.driver` compiles. The provider's start() must turn that
 * into a boot failure that names the bad value, not a generic "no active
 * driver" on the first tenant query.
 */
function fakeDriver(name: string): IsolationDriver {
  return {
    name,
    contractVersion: 1,
    enforce: () => {},
    provision: async () => {},
    destroy: async () => {},
    reset: async () => {},
    connect: async () => {},
    disconnect: async () => {},
    connectionName: (id: string) => `t_${id}`,
    tableLocation: (t: { id: string }) => ({
      kind: 'connection' as const,
      connectionName: `t_${t.id}`,
    }),
    migrate: async () => ({ executed: 0 }),
  } as unknown as IsolationDriver
}

test.group('assertConfiguredDriverRegistered()', () => {
  test('passes when the configured driver is registered', ({ assert }) => {
    const registry = new IsolationDriverRegistry()
    registry.register(fakeDriver('schema-pg'))
    assert.doesNotThrow(() => assertConfiguredDriverRegistered(registry, 'schema-pg'))
  })

  test('passes for a registered custom driver name', ({ assert }) => {
    const registry = new IsolationDriverRegistry()
    registry.register(fakeDriver('my-driver'))
    assert.doesNotThrow(() => assertConfiguredDriverRegistered(registry, 'my-driver'))
  })

  test('throws IsolationConfigException naming a typo`d driver and the registered ones', ({
    assert,
  }) => {
    const registry = new IsolationDriverRegistry()
    registry.register(fakeDriver('schema-pg'))

    try {
      assertConfiguredDriverRegistered(registry, 'shcema-pg')
      assert.fail('expected a throw for an unregistered driver name')
    } catch (error) {
      assert.instanceOf(error, IsolationConfigException)
      assert.include(error.message, '"shcema-pg"', 'the bad value must be named')
      assert.include(error.message, 'schema-pg', 'the registered drivers must be listed')
    }
  })

  test('an empty registry is reported as such', ({ assert }) => {
    const registry = new IsolationDriverRegistry()
    try {
      assertConfiguredDriverRegistered(registry, 'my-driver')
      assert.fail('expected a throw on an empty registry')
    } catch (error) {
      assert.instanceOf(error, IsolationConfigException)
      assert.include(error.message, '(none)')
    }
  })
})

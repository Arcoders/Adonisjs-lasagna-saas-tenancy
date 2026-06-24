import { test } from '@japa/runner'
import ReportExtensionRegistry from '../../src/report_extension_registry.js'
import type { ReportExtension } from '../../src/contracts/report_extension.js'

function ext(name: string): ReportExtension {
  return { name, description: `the ${name} report`, execute: async () => ({ ok: name }) }
}

test.group('ReportExtensionRegistry', () => {
  test('register / get / has / list round-trip', ({ assert }) => {
    const reg = new ReportExtensionRegistry()
    reg.register(ext('top_properties')).register(ext('churn'))
    assert.isTrue(reg.has('top_properties'))
    assert.equal(reg.get('churn')?.description, 'the churn report')
    assert.deepEqual([...reg.list()].sort(), ['churn', 'top_properties'])
  })

  test('rejects a duplicate name', ({ assert }) => {
    const reg = new ReportExtensionRegistry()
    reg.register(ext('dup'))
    assert.throws(() => reg.register(ext('dup')), /already registered/)
  })

  test('rejects an unsafe name', ({ assert }) => {
    const reg = new ReportExtensionRegistry()
    assert.throws(() => reg.register(ext("x'; DROP")), /unsafe metric name/)
    assert.throws(() => reg.register(ext('a b')), /unsafe metric name/)
  })

  test('unknown lookups are undefined / false', ({ assert }) => {
    const reg = new ReportExtensionRegistry()
    assert.isUndefined(reg.get('nope'))
    assert.isFalse(reg.has('nope'))
  })

  test('clear empties the registry', ({ assert }) => {
    const reg = new ReportExtensionRegistry()
    reg.register(ext('a'))
    reg.clear()
    assert.lengthOf(reg.list(), 0)
  })
})

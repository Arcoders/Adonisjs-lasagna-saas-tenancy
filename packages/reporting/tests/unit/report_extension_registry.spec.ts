import { test } from '@japa/runner'
import ReportExtensionRegistry from '../../src/report_extension_registry.js'
import { REPORTING_CONTRACT_VERSION } from '../../src/constants.js'
import type { ReportExtension } from '../../src/contracts/report_extension.js'

function ext(name: string): ReportExtension {
  return {
    name,
    description: `the ${name} report`,
    contractVersion: REPORTING_CONTRACT_VERSION,
    execute: async () => ({ ok: name }),
  }
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

  test('exposes the surface contractVersion', ({ assert }) => {
    assert.equal(new ReportExtensionRegistry().contractVersion, REPORTING_CONTRACT_VERSION)
  })
})

function versioned(name: string, contractVersion?: number): ReportExtension {
  return { name, description: name, contractVersion, execute: async () => ({ ok: name }) }
}

test.group('ReportExtensionRegistry — contractVersion compatibility', () => {
  // The surface is pinned to v2 in these tests so we can exercise both
  // directions (newer + older) regardless of the real REPORTING_CONTRACT_VERSION.
  const SURFACE = 2

  test('equal version → registers, no warning', ({ assert }) => {
    const warnings: string[] = []
    const reg = new ReportExtensionRegistry(SURFACE, (m) => warnings.push(m))
    reg.register(versioned('compatible', 2))
    assert.isTrue(reg.has('compatible'))
    assert.lengthOf(warnings, 0)
  })

  test('newer than the surface → throws (fail-fast at registration)', ({ assert }) => {
    const reg = new ReportExtensionRegistry(SURFACE)
    assert.throws(() => reg.register(versioned('too_new', 3)), /requires extension contract v3/)
    assert.isFalse(reg.has('too_new'))
  })

  test('older than the surface → warns but still registers (degraded)', ({ assert }) => {
    const warnings: string[] = []
    const reg = new ReportExtensionRegistry(SURFACE, (m) => warnings.push(m))
    reg.register(versioned('legacy', 1))
    assert.isTrue(reg.has('legacy'))
    assert.lengthOf(warnings, 1)
    assert.match(warnings[0], /built for extension contract v1/)
  })

  test('absent version → warns (unversioned) but registers', ({ assert }) => {
    const warnings: string[] = []
    const reg = new ReportExtensionRegistry(SURFACE, (m) => warnings.push(m))
    reg.register(versioned('unversioned', undefined))
    assert.isTrue(reg.has('unversioned'))
    assert.lengthOf(warnings, 1)
    assert.match(warnings[0], /does not declare a contractVersion/)
  })
})

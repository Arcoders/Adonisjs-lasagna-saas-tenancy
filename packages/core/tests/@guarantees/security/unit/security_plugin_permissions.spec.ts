import { test } from '@japa/runner'
import {
  permission,
  serializePluginPermission,
  parsePluginPermission,
  serializePluginPermissions,
  parsePluginPermissions,
  PLUGIN_PERMISSION_KINDS,
  type PluginPermission,
} from '../../../../src/sdk/plugin_permissions.js'
import { readSatelliteManifest } from '../../../../src/sdk/manifest.js'
import { describePluginPermissions } from '../../../../src/sdk/configure_kit.js'

/**
 * The plugin permission model is the S1 install-consent contract: what a plugin
 * declares (via the builders + `definePlugin({ permissions })`), how it
 * serializes to the manifest wire form the operator consents to, and that a
 * hostile declaration cannot slip through. These tests pin the bijection and the
 * fail-closed parse so the guard and configure can trust both ends.
 */

test.group('plugin permissions — builders + wire bijection', () => {
  test('each builder stamps the right kind', ({ assert }) => {
    assert.deepEqual(permission.scheduler(), { kind: 'scheduler' })
    assert.deepEqual(permission.networkExternal(), { kind: 'network_external' })
    assert.deepEqual(permission.dbWrite(), { kind: 'db_write' })
    assert.deepEqual(permission.dataChange('User', 'Order'), {
      kind: 'data_change',
      models: ['User', 'Order'],
    })
  })

  test('canonical wire forms are exactly the documented strings', ({ assert }) => {
    assert.equal(serializePluginPermission(permission.scheduler()), 'scheduler')
    assert.equal(serializePluginPermission(permission.networkExternal()), 'network:external')
    assert.equal(serializePluginPermission(permission.dbWrite()), 'db:write')
    assert.equal(
      serializePluginPermission(permission.dataChange('users', 'orders')),
      'data_change:users,orders'
    )
  })

  test('serialize → parse round-trips every kind', ({ assert }) => {
    const all: PluginPermission[] = [
      permission.scheduler(),
      permission.networkExternal(),
      permission.dbWrite(),
      permission.dataChange('users', 'orders'),
    ]
    for (const p of all) {
      assert.deepEqual(parsePluginPermission(serializePluginPermission(p)), p)
    }
  })

  test('PLUGIN_PERMISSION_KINDS lists every kind (exhaustiveness anchor)', ({ assert }) => {
    assert.deepEqual([...PLUGIN_PERMISSION_KINDS].sort(), [
      'data_change',
      'db_write',
      'network_external',
      'scheduler',
    ])
  })
})

test.group('plugin permissions — fail-closed parse', () => {
  test('unrecognized wire strings parse to null', ({ assert }) => {
    for (const bad of ['', 'bogus', 'db:read', 'network:internal', 'data_change']) {
      assert.isNull(parsePluginPermission(bad), `should reject: "${bad}"`)
    }
  })

  test('a data_change with no models is rejected', ({ assert }) => {
    assert.isNull(parsePluginPermission('data_change:'))
    assert.isNull(parsePluginPermission('data_change:,,'))
  })

  test('a hostile model identifier invalidates the whole data_change permission', ({ assert }) => {
    assert.isNull(parsePluginPermission('data_change:users,bad name'))
    assert.isNull(parsePluginPermission('data_change:a;b'))
    assert.isNull(parsePluginPermission('data_change:users,"or"'))
  })

  test('the dataChange builder rejects a hostile model at authoring time', ({ assert }) => {
    assert.throws(() => permission.dataChange('bad name'), /unsafe/)
    assert.throws(() => permission.dataChange('users', 'a:b'), /unsafe/)
  })

  test('parsePluginPermissions keeps the valid entries and reports the dropped ones', ({
    assert,
  }) => {
    const dropped: string[] = []
    const parsed = parsePluginPermissions(['scheduler', 'bogus', 'db:write'], (d) =>
      dropped.push(d)
    )
    assert.deepEqual(parsed, [{ kind: 'scheduler' }, { kind: 'db_write' }])
    assert.deepEqual(dropped, ['bogus'])
  })

  test('serializePluginPermissions preserves order', ({ assert }) => {
    assert.deepEqual(serializePluginPermissions([permission.dbWrite(), permission.scheduler()]), [
      'db:write',
      'scheduler',
    ])
  })
})

test.group('plugin permissions — manifest integration', () => {
  test('readSatelliteManifest parses + canonicalizes permissions and nativeAddons', ({
    assert,
  }) => {
    const manifest = readSatelliteManifest({
      name: '@me/plugin',
      lasagnaSatellite: {
        name: 'plugin',
        permissions: ['scheduler', 'data_change:users', 'db:write'],
        nativeAddons: true,
      },
    })
    assert.deepEqual(manifest?.permissions, ['scheduler', 'data_change:users', 'db:write'])
    assert.isTrue(manifest?.nativeAddons)
  })

  test('an invalid permission entry is dropped with a warning, valid ones kept', ({ assert }) => {
    const warnings: string[] = []
    const manifest = readSatelliteManifest(
      {
        name: '@me/plugin',
        lasagnaSatellite: { name: 'plugin', permissions: ['scheduler', 'nope', 'data_change:'] },
      },
      (m) => warnings.push(m)
    )
    assert.deepEqual(manifest?.permissions, ['scheduler'])
    assert.isTrue(warnings.some((w) => w.includes('nope')))
    assert.isTrue(warnings.some((w) => w.includes('data_change:')))
  })

  test('a non-array permissions field is dropped with a warning', ({ assert }) => {
    const warnings: string[] = []
    const manifest = readSatelliteManifest(
      { name: '@me/plugin', lasagnaSatellite: { name: 'plugin', permissions: 'scheduler' } },
      (m) => warnings.push(m)
    )
    assert.isUndefined(manifest?.permissions)
    assert.isTrue(warnings.some((w) => w.includes('must be an array')))
  })

  test('a non-boolean nativeAddons is dropped with a warning', ({ assert }) => {
    const warnings: string[] = []
    const manifest = readSatelliteManifest(
      { name: '@me/plugin', lasagnaSatellite: { name: 'plugin', nativeAddons: 'yes' } },
      (m) => warnings.push(m)
    )
    assert.isUndefined(manifest?.nativeAddons)
    assert.isTrue(warnings.some((w) => w.includes('must be a boolean')))
  })
})

test.group('plugin permissions — install-consent display', () => {
  test('describePluginPermissions turns wire strings into concrete human lines', ({ assert }) => {
    const lines = describePluginPermissions([
      'scheduler',
      'db:write',
      'network:external',
      'data_change:users,orders',
    ])
    assert.isTrue(lines[0].startsWith('scheduler —'))
    assert.isTrue(lines[1].includes('writes to the tenant database'))
    assert.isTrue(lines[2].includes('outbound calls'))
    assert.isTrue(lines[3].includes('users, orders'))
  })

  test('an unrecognized wire string passes through verbatim (forward-compatible)', ({ assert }) => {
    assert.deepEqual(describePluginPermissions(['future:capability']), ['future:capability'])
  })
})

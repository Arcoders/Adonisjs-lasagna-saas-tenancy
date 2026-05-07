import { test } from '@japa/runner'
import ReadReplicaService from '../../../src/services/read_replica_service.js'
import type { ReadReplicaHost, ReadReplicaStrategy } from '../../../src/types/config.js'
import { setupTestConfig, testConfig } from '../../helpers/config.js'

function setupReplicas(hosts: ReadReplicaHost[], strategy?: ReadReplicaStrategy) {
  setupTestConfig({
    ...testConfig,
    tenantReadReplicas: { hosts, strategy },
  } as any)
}

test.group('ReadReplicaService — disabled', (group) => {
  group.each.setup(() => setupTestConfig())

  test('pickIndex returns null when no config is present', ({ assert }) => {
    const svc = new ReadReplicaService()
    assert.isNull(svc.pickIndex('any-tenant'))
  })

  test('pickHost returns null when no config is present', ({ assert }) => {
    const svc = new ReadReplicaService()
    assert.isNull(svc.pickHost('any-tenant'))
  })

  test('pickIndex returns null when hosts array is empty', ({ assert }) => {
    setupReplicas([])
    const svc = new ReadReplicaService()
    assert.isNull(svc.pickIndex('any-tenant'))
  })
})

test.group('ReadReplicaService — round-robin', (group) => {
  group.each.setup(() => setupTestConfig())

  test('cycles through hosts in order', ({ assert }) => {
    setupReplicas(
      [
        { host: 'replica-1' },
        { host: 'replica-2' },
        { host: 'replica-3' },
      ],
      'round-robin'
    )
    const svc = new ReadReplicaService()
    assert.equal(svc.pickIndex('t')!, 0)
    assert.equal(svc.pickIndex('t')!, 1)
    assert.equal(svc.pickIndex('t')!, 2)
    assert.equal(svc.pickIndex('t')!, 0)
  })

  test('default strategy is round-robin', ({ assert }) => {
    setupReplicas([{ host: 'a' }, { host: 'b' }])
    const svc = new ReadReplicaService()
    assert.equal(svc.pickIndex('t')!, 0)
    assert.equal(svc.pickIndex('t')!, 1)
  })

  test('resetCursor returns the rotation to zero', ({ assert }) => {
    setupReplicas([{ host: 'a' }, { host: 'b' }, { host: 'c' }], 'round-robin')
    const svc = new ReadReplicaService()
    svc.pickIndex('t')
    svc.pickIndex('t')
    svc.resetCursor()
    assert.equal(svc.pickIndex('t')!, 0)
  })

  test('pickHost matches the index', ({ assert }) => {
    setupReplicas([{ host: 'a' }, { host: 'b' }], 'round-robin')
    const svc = new ReadReplicaService()
    assert.equal(svc.pickHost('t')!.host, 'a')
    assert.equal(svc.pickHost('t')!.host, 'b')
  })
})

test.group('ReadReplicaService — sticky', (group) => {
  group.each.setup(() => setupTestConfig())

  test('returns the same index for the same tenant id every time', ({ assert }) => {
    setupReplicas(
      [{ host: 'a' }, { host: 'b' }, { host: 'c' }, { host: 'd' }],
      'sticky'
    )
    const svc = new ReadReplicaService()
    const first = svc.pickIndex('tenant-42')
    for (let i = 0; i < 20; i++) {
      assert.equal(svc.pickIndex('tenant-42'), first)
    }
  })

  test('different tenant ids may land on different replicas', ({ assert }) => {
    setupReplicas(
      [{ host: 'a' }, { host: 'b' }, { host: 'c' }, { host: 'd' }, { host: 'e' }],
      'sticky'
    )
    const svc = new ReadReplicaService()
    const ids = ['t-1', 't-2', 't-3', 't-4', 't-5', 't-6', 't-7', 't-8', 't-9', 't-10']
    const indices = ids.map((id) => svc.pickIndex(id)!)
    assert.isAbove(new Set(indices).size, 1, 'sticky distribution should hit >1 replica')
  })
})

test.group('ReadReplicaService — random', (group) => {
  group.each.setup(() => setupTestConfig())

  test('returns an index within the hosts range', ({ assert }) => {
    setupReplicas([{ host: 'a' }, { host: 'b' }, { host: 'c' }], 'random')
    const svc = new ReadReplicaService()
    for (let i = 0; i < 50; i++) {
      const idx = svc.pickIndex('t')!
      assert.isAtLeast(idx, 0)
      assert.isBelow(idx, 3)
    }
  })
})

test.group('ReadReplicaService — connectionName', (group) => {
  group.each.setup(() => setupTestConfig())

  test('uses the global tenantConnectionNamePrefix and default suffix', ({ assert }) => {
    setupReplicas([{ host: 'a' }])
    const svc = new ReadReplicaService()
    assert.equal(svc.connectionName('abc-123', 0), 'tenant_abc-123_read_0')
  })

  test('respects a custom connectionSuffix', ({ assert }) => {
    setupTestConfig({
      ...testConfig,
      tenantReadReplicas: {
        hosts: [{ host: 'a' }],
        connectionSuffix: '_ro',
      },
    } as any)
    const svc = new ReadReplicaService()
    assert.equal(svc.connectionName('abc-123', 2), 'tenant_abc-123_ro_2')
  })
})

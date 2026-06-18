import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { buildTestTenant } from '@adonisjs-lasagna/saas-tenancy/internal'
import type { TenantModelContract, TenantStatus } from '@adonisjs-lasagna/saas-tenancy/types'
import TenantSocketServer, {
  tenantRoom,
  type TenantSocketServerDeps,
} from '../../src/tenant_socket_server.js'
import { resolveTenantIdFromHandshake } from '../../src/resolve_from_handshake.js'
import type { IoHandshake } from '../../src/types.js'
import { FakeIo, FakeSocket } from '../helpers/fake_io.js'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

/**
 * A real ALS-backed harness so `currentTenantId()` reflects active
 * `runAsTenant` scopes, the same mechanism core's `TenantLogContext` uses.
 */
function harness(
  opts: {
    tenants?: TenantModelContract[]
    authorize?: TenantSocketServerDeps['authorize']
    loadTenant?: TenantSocketServerDeps['loadTenant']
    connectTenant?: TenantSocketServerDeps['connectTenant']
  } = {}
) {
  const als = new AsyncLocalStorage<string>()
  const tenants = new Map((opts.tenants ?? []).map((t) => [t.id, t]))
  const connectCalls: string[] = []
  const currentTenantId = () => als.getStore()

  const deps: TenantSocketServerDeps = {
    resolveTenantId: (h: IoHandshake) => resolveTenantIdFromHandshake(h, {}),
    loadTenant: opts.loadTenant ?? (async (id) => tenants.get(id) ?? null),
    assertServiceable: (t) => {
      if (t.isSuspended || t.isDeleted) throw withCode('TENANT_SUSPENDED', 'suspended')
    },
    connectTenant:
      opts.connectTenant ??
      (async (t) => {
        connectCalls.push(t.id)
      }),
    runAsTenant: (t, fn) => Promise.resolve(als.run(t.id, fn)),
    currentTenantId,
    authorize: opts.authorize,
  }

  return { server: new TenantSocketServer(deps), io: new FakeIo(), connectCalls, currentTenantId }
}

function withCode(code: string, message: string): Error {
  const err = new Error(message)
  ;(err as Error & { data?: unknown }).data = { code }
  return err
}

function socket(id: string, tenantId: string | undefined): FakeSocket {
  return new FakeSocket(id, { auth: tenantId ? { tenantId } : {}, headers: {}, query: {} })
}

function tenant(id: string, status: TenantStatus = 'active'): TenantModelContract {
  return buildTestTenant({ id, status })
}

test.group('TenantSocketServer: handshake', () => {
  test('accepts an active tenant: connects, sets data.tenant, joins the room', async ({
    assert,
  }) => {
    const { server, io, connectCalls } = harness({ tenants: [tenant(UUID_A)] })
    server.attach(io)

    const s = socket('s1', UUID_A)
    const result = await io.connect(s)

    assert.isTrue(result.ok)
    assert.equal((s.data.tenant as TenantModelContract)?.id, UUID_A)
    assert.isTrue(s.rooms.has(tenantRoom(UUID_A)))
    assert.deepEqual(connectCalls, [UUID_A])
  })

  test('rejects when no tenant id is present', async ({ assert }) => {
    const { server, io } = harness()
    server.attach(io)

    const result = await io.connect(socket('s1', undefined))

    assert.isFalse(result.ok)
    assert.equal(result.code, 'TENANT_REQUIRED')
  })

  test('rejects a non-UUID id', async ({ assert }) => {
    const { server, io } = harness()
    server.attach(io)

    const result = await io.connect(
      new FakeSocket('s1', { auth: { tenantId: 'nope' }, headers: {}, query: {} })
    )

    assert.isFalse(result.ok)
    assert.equal(result.code, 'TENANT_REQUIRED')
  })

  test('rejects an unknown tenant', async ({ assert }) => {
    const { server, io } = harness({ tenants: [] })
    server.attach(io)

    const result = await io.connect(socket('s1', UUID_A))

    assert.isFalse(result.ok)
    assert.equal(result.code, 'TENANT_NOT_FOUND')
  })

  test('rejects a suspended tenant before connecting', async ({ assert }) => {
    const { server, io, connectCalls } = harness({ tenants: [tenant(UUID_A, 'suspended')] })
    server.attach(io)

    const result = await io.connect(socket('s1', UUID_A))

    assert.isFalse(result.ok)
    assert.equal(result.code, 'TENANT_SUSPENDED')
    assert.lengthOf(connectCalls, 0)
  })

  test('rejects when authorize() returns false', async ({ assert }) => {
    const { server, io } = harness({ tenants: [tenant(UUID_A)], authorize: async () => false })
    server.attach(io)

    const result = await io.connect(socket('s1', UUID_A))

    assert.isFalse(result.ok)
    assert.equal(result.code, 'UNAUTHORIZED')
  })

  test('maps a tenant-lookup failure to a generic TENANT_UNAVAILABLE (no raw error leak)', async ({
    assert,
  }) => {
    const { server, io } = harness({
      loadTenant: async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
      },
    })
    server.attach(io)

    const result = await io.connect(socket('s1', UUID_A))

    assert.isFalse(result.ok)
    assert.equal(result.code, 'TENANT_UNAVAILABLE')
    assert.notInclude(result.error?.message ?? '', 'ECONNREFUSED')
  })

  test('maps a connection failure to TENANT_UNAVAILABLE', async ({ assert }) => {
    const { server, io } = harness({
      tenants: [tenant(UUID_A)],
      connectTenant: async () => {
        throw new Error('pool exhausted')
      },
    })
    server.attach(io)

    const result = await io.connect(socket('s1', UUID_A))

    assert.isFalse(result.ok)
    assert.equal(result.code, 'TENANT_UNAVAILABLE')
  })

  test('fails closed (UNAUTHORIZED) when the authorize hook throws', async ({ assert }) => {
    const { server, io } = harness({
      tenants: [tenant(UUID_A)],
      authorize: async () => {
        throw new Error('jwt verify boom')
      },
    })
    server.attach(io)

    const result = await io.connect(socket('s1', UUID_A))

    assert.isFalse(result.ok)
    assert.equal(result.code, 'UNAUTHORIZED')
    assert.notInclude(result.error?.message ?? '', 'jwt verify boom')
  })
})

test.group('TenantSocketServer: per-event tenant context', () => {
  test('bindTenant re-connects then runs the handler inside the tenant scope', async ({
    assert,
  }) => {
    const { server, io, connectCalls, currentTenantId } = harness({ tenants: [tenant(UUID_A)] })
    server.attach(io)
    const s = socket('s1', UUID_A)
    await io.connect(s)

    let observed: string | undefined
    await server.bindTenant(s, () => {
      observed = currentTenantId()
    })()

    assert.equal(observed, UUID_A)
    // handshake connect + per-event connect (idempotent liveness refresh)
    assert.deepEqual(connectCalls, [UUID_A, UUID_A])
  })

  test('onTenantEvent runs the registered handler with context', async ({ assert }) => {
    const { server, io, currentTenantId } = harness({ tenants: [tenant(UUID_A)] })
    server.attach(io)
    const s = socket('s1', UUID_A)
    await io.connect(s)

    let observed: string | undefined
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    server.onTenantEvent(s, 'ping', () => {
      observed = currentTenantId()
      resolveDone()
    })

    s.emitIncoming('ping')
    await done

    assert.equal(observed, UUID_A)
  })

  test('onConnection callbacks fire per socket and wire handlers with context', async ({
    assert,
  }) => {
    const { server, io, currentTenantId } = harness({ tenants: [tenant(UUID_A)] })
    server.attach(io)

    let observed: string | undefined
    let resolveDone!: () => void
    const done = new Promise<void>((r) => (resolveDone = r))
    server.onConnection((connected) => {
      server.onTenantEvent(connected, 'ping', () => {
        observed = currentTenantId()
        resolveDone()
      })
    })

    const s = socket('s1', UUID_A)
    await io.connect(s)
    s.emitIncoming('ping')
    await done

    assert.equal(observed, UUID_A)
  })

  test('concurrent sockets never leak tenant context across scopes', async ({ assert }) => {
    const { server, io, currentTenantId } = harness({
      tenants: [tenant(UUID_A), tenant(UUID_B)],
    })
    server.attach(io)
    const a = socket('a', UUID_A)
    const b = socket('b', UUID_B)
    await io.connect(a)
    await io.connect(b)

    const seen: string[] = []
    const run = (s: FakeSocket, expected: string) =>
      server.bindTenant(s, async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 8))
        seen.push(`${expected}:${currentTenantId()}`)
      })()

    await Promise.all([run(a, UUID_A), run(b, UUID_B), run(a, UUID_A), run(b, UUID_B)])

    for (const entry of seen) {
      const [expected, actual] = entry.split(':')
      assert.equal(actual, expected)
    }
  })
})

test.group('TenantSocketServer: scoped emit + severance', () => {
  test('emitToTenant reaches only that tenant’s sockets', async ({ assert }) => {
    const { server, io } = harness({ tenants: [tenant(UUID_A), tenant(UUID_B)] })
    server.attach(io)
    const a = socket('a', UUID_A)
    const b = socket('b', UUID_B)
    await io.connect(a)
    await io.connect(b)

    server.emitToTenant(UUID_B, 'msg', { hello: 'b' })

    assert.lengthOf(a.received, 0)
    assert.deepEqual(b.received, [{ event: 'msg', args: [{ hello: 'b' }] }])
  })

  test('broadcastToTenant inside a handler hits only the current room', async ({ assert }) => {
    const { server, io } = harness({ tenants: [tenant(UUID_A), tenant(UUID_B)] })
    server.attach(io)
    const a = socket('a', UUID_A)
    const b = socket('b', UUID_B)
    await io.connect(a)
    await io.connect(b)

    await server.bindTenant(a, () => server.broadcastToTenant('news', 1))()

    assert.deepEqual(a.received, [{ event: 'news', args: [1] }])
    assert.lengthOf(b.received, 0)
  })

  test('broadcastToTenant throws outside a bound handler', ({ assert }) => {
    const { server, io } = harness({ tenants: [tenant(UUID_A)] })
    server.attach(io)

    assert.throws(() => server.broadcastToTenant('news', 1), /outside a bound socket handler/)
  })

  test('disconnectTenant severs that tenant only', async ({ assert }) => {
    const { server, io } = harness({ tenants: [tenant(UUID_A), tenant(UUID_B)] })
    server.attach(io)
    const a = socket('a', UUID_A)
    const b = socket('b', UUID_B)
    await io.connect(a)
    await io.connect(b)

    server.disconnectTenant(UUID_A)

    assert.isFalse(a.connected)
    assert.isTrue(b.connected)
  })

  test('tenantRoom rejects an unsafe id', ({ assert }) => {
    assert.throws(() => tenantRoom('bad id!'), /unsafe/)
  })

  test('close() drains and disconnects sockets', async ({ assert }) => {
    const { server, io } = harness({ tenants: [tenant(UUID_A)] })
    server.attach(io)
    const a = socket('a', UUID_A)
    await io.connect(a)

    await server.close()

    assert.isTrue(io.closed)
    assert.isFalse(a.connected)
  })

  test('emit helpers throw before attach()', ({ assert }) => {
    const { server } = harness()
    assert.throws(() => server.emitToTenant(UUID_A, 'x'), /attach\(io\) has not been called/)
  })
})

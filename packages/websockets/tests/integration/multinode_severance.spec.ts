import { test } from '@japa/runner'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer, type Server as HttpServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { buildTestTenant } from '@adonisjs-lasagna/saas-tenancy/internal'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import TenantSocketServer, { type TenantSocketServerDeps } from '../../src/tenant_socket_server.js'
import { resolveTenantIdFromHandshake } from '../../src/resolve_from_handshake.js'

/**
 * Multi-node WebSocket severance (Phase 4 chaos). socket.io rooms are
 * per-process, so a tenant suspended on one node leaves its sockets connected on
 * the others — a real isolation gap at scale. The cookbook closes it with a Redis
 * pub/sub bridge: every node publishes the tenant id when it severs, and every
 * node subscribes and calls `disconnectTenant()` locally when a message arrives
 * (docs/docs/cookbook/multi-tenant-websockets.md, "Scaling to multiple nodes").
 *
 * This boots TWO real socket.io servers wired exactly like the recipe — the
 * @socket.io/redis-adapter for emit fan-out, plus the severance bridge — and
 * proves both halves across nodes:
 *   - suspending a tenant on node A severs its sockets on BOTH nodes, while a
 *     different tenant's socket stays connected (the headline guarantee);
 *   - emitToTenant on node A reaches that tenant's socket on node B.
 *
 * Needs Redis (REDIS_HOST/PORT, default 127.0.0.1:6379) and the optional WS
 * peers; self-skips when socket.io / socket.io-client / @socket.io/redis-adapter
 * are not installed (the demo e2e job runs without them).
 */

const REDIS_HOST = process.env.REDIS_HOST ?? '127.0.0.1'
const REDIS_PORT = Number(process.env.REDIS_PORT ?? 6379)
// Unique per run so a stale message can never bleed into another suite/process.
const SEVER_CHANNEL = `lasagna:ws:sever-tenant:test:${randomUUID()}`

// Load the optional peers dynamically so the spec self-skips where they are
// absent, matching the repo's "backend not present → skip" convention.
type Mods = {
  Server: any
  ioClient: (url: string, opts: any) => any
  createAdapter: (pub: any, sub: any) => any
  Redis: new (opts: any) => any
}
let mods: Mods | null = null
try {
  const [io, client, adapter, ioredis] = await Promise.all([
    import('socket.io'),
    import('socket.io-client'),
    import('@socket.io/redis-adapter'),
    import('ioredis'),
  ])
  mods = {
    Server: (io as any).Server,
    ioClient: (client as any).io ?? (client as any).default?.io ?? (client as any).connect,
    createAdapter: (adapter as any).createAdapter,
    Redis: (ioredis as any).default ?? (ioredis as any).Redis,
  }
} catch {
  mods = null
}
const SHOULD_RUN = mods !== null
const SKIP_REASON =
  'socket.io / socket.io-client / @socket.io/redis-adapter not installed — multi-node WS severance skipped'

function newRedis(): any {
  return new mods!.Redis({ host: REDIS_HOST, port: REDIS_PORT, lazyConnect: false })
}

function awaitEvent(emitter: any, event: string, ms = 5000): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for "${event}"`)), ms)
    emitter.once(event, (...args: unknown[]) => {
      clearTimeout(timer)
      resolve(args)
    })
  })
}

test.group('Multi-node WebSocket severance (integration)', (group) => {
  const als = new AsyncLocalStorage<string>()
  const tenants = new Map<string, TenantModelContract>()

  const deps: TenantSocketServerDeps = {
    resolveTenantId: (h) => resolveTenantIdFromHandshake(h, {}),
    loadTenant: async (id) => tenants.get(id) ?? null,
    assertServiceable: (t) => {
      if (t.isSuspended || t.isDeleted) {
        const err = new Error('suspended') as Error & { data?: unknown }
        err.data = { code: 'TENANT_SUSPENDED' }
        throw err
      }
    },
    connectTenant: async () => {},
    runAsTenant: (t, fn) => Promise.resolve(als.run(t.id, fn)),
    currentTenantId: () => als.getStore(),
  }

  interface Node {
    httpServer: HttpServer
    io: any
    server: TenantSocketServer
    port: number
    close: () => Promise<void>
  }

  // Each node mirrors a fresh app instance: its own socket.io server, the Redis
  // adapter for emit fan-out, and the severance-bridge subscriber.
  async function makeNode(): Promise<Node> {
    const httpServer = createServer()
    const io = new mods!.Server(httpServer, { transports: ['websocket'] })

    const pub = newRedis()
    const sub = pub.duplicate()
    io.adapter(mods!.createAdapter(pub, sub))

    const server = new TenantSocketServer(deps)
    server.attach(io)

    // The documented bridge: subscribe and sever locally when any node publishes.
    const bridgeSub = newRedis()
    await bridgeSub.subscribe(SEVER_CHANNEL)
    bridgeSub.on('message', (channel: string, tenantId: string) => {
      if (channel === SEVER_CHANNEL) server.disconnectTenant(tenantId)
    })

    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve))
    const port = (httpServer.address() as AddressInfo).port

    return {
      httpServer,
      io,
      server,
      port,
      close: async () => {
        await server.close().catch(() => {})
        await new Promise<void>((resolve) => httpServer.close(() => resolve()))
        await Promise.all([pub, sub, bridgeSub].map((c) => c.quit().catch(() => {})))
      },
    }
  }

  let nodeA: Node
  let nodeB: Node
  let publisher: any
  const clients: any[] = []

  function connectClient(node: Node, tenantId: string): any {
    const c = mods!.ioClient(`http://127.0.0.1:${node.port}`, {
      auth: { tenantId },
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
    })
    clients.push(c)
    return c
  }

  group.setup(async () => {
    if (!SHOULD_RUN) return
    nodeA = await makeNode()
    nodeB = await makeNode()
    publisher = newRedis()
  })

  group.teardown(async () => {
    if (!SHOULD_RUN) return
    await publisher?.quit().catch(() => {})
    await nodeA?.close()
    await nodeB?.close()
  })

  group.each.teardown(() => {
    for (const c of clients.splice(0)) c.close?.()
    tenants.clear()
  })

  test('suspend on one node severs the tenant on BOTH nodes, sparing other tenants', async ({
    assert,
  }) => {
    const suspended = randomUUID()
    const other = randomUUID()
    tenants.set(suspended, buildTestTenant({ id: suspended, status: 'active' }))
    tenants.set(other, buildTestTenant({ id: other, status: 'active' }))

    // Two sockets for the doomed tenant — one on each node — plus a control
    // socket for a different tenant on node B.
    const onA = connectClient(nodeA, suspended)
    const onB = connectClient(nodeB, suspended)
    const control = connectClient(nodeB, other)
    await Promise.all([
      awaitEvent(onA, 'connect'),
      awaitEvent(onB, 'connect'),
      awaitEvent(control, 'connect'),
    ])

    // Both doomed sockets must close; capture the promises before we publish.
    const severed = Promise.all([awaitEvent(onA, 'disconnect'), awaitEvent(onB, 'disconnect')])

    // Simulate the suspend handler firing on node A: it publishes the id, which
    // every node (including B) receives and severs locally.
    await publisher.publish(SEVER_CHANNEL, suspended)

    await severed
    assert.isFalse(
      onA.connected,
      'the suspended tenant is severed on the node that saw the suspend'
    )
    assert.isFalse(onB.connected, 'and severed on the OTHER node via the Redis bridge')
    assert.isTrue(control.connected, 'a different tenant on the same node is untouched')
  })
    .skip(!SHOULD_RUN, SKIP_REASON)
    .timeout(20_000)

  test('emitToTenant on one node reaches that tenant on the other node', async ({ assert }) => {
    const tid = randomUUID()
    tenants.set(tid, buildTestTenant({ id: tid, status: 'active' }))

    const onB = connectClient(nodeB, tid)
    await awaitEvent(onB, 'connect')

    const got = awaitEvent(onB, 'broadcast:news')
    // Node A has no local socket for this tenant; the adapter must fan the emit
    // out to node B, where the socket actually lives.
    nodeA.server.emitToTenant(tid, 'broadcast:news', { headline: 'cross-node' })

    const [payload] = (await got) as [{ headline: string }]
    assert.equal(payload.headline, 'cross-node')
  })
    .skip(!SHOULD_RUN, SKIP_REASON)
    .timeout(20_000)
})

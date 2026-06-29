import { test } from '@japa/runner'
import emitter from '@adonisjs/core/services/emitter'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import Tenant from '#app/models/backoffice/tenant'
import ChatMessage from '#app/models/tenant_scoped/chat_message'
import { createInstalledTenant, dropAllTenants } from './_helpers.js'

/**
 * End-to-end proof of the @adonisjs-lasagna/websockets satellite over a REAL
 * socket.io connection: two tenants connect, and a message sent by one is
 * delivered only to that tenant's room AND persisted only in that tenant's
 * schema. Also covers handshake rejection.
 *
 * socket.io is an optional peer, so this spec self-skips when socket.io /
 * socket.io-client are not installed (the convention the *_real smoke specs
 * follow). The dedicated CI job installs them; the general e2e job skips it.
 */

// Import via a specifier TypeScript must not resolve at build time, so the
// project still typechecks without socket.io installed.
function dyn(specifier: string): Promise<any> {
  return (Function('s', 'return import(s)') as (s: string) => Promise<any>)(specifier).catch(
    () => null
  )
}

const ioClientMod: any = await dyn('socket.io-client')
const ioServerMod: any = await dyn('socket.io')
const hasWs = Boolean(ioClientMod && ioServerMod)
const ioClient: any = ioClientMod?.io ?? ioClientMod?.default

const HOST = !process.env.HOST || process.env.HOST === '0.0.0.0' ? '127.0.0.1' : process.env.HOST
const PORT = Number(process.env.PORT ?? 3333)
const SERVER_URL = `http://${HOST}:${PORT}`

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Open a client connection; resolves on `connect`, rejects on `connect_error`. */
function connect(tenantId: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(SERVER_URL, {
      auth: { tenantId },
      transports: ['websocket'],
      reconnection: false,
      timeout: 5000,
    })
    socket.on('connect', () => resolve(socket))
    socket.on('connect_error', (err: Error) => {
      socket.close()
      reject(err)
    })
  })
}

test.group('e2e websockets: tenant isolation', (group) => {
  group.setup(async () => {
    await dropAllTenants()
    if (!hasWs) return
    // testUtils.httpServer().start() (the suite setup) listens but does NOT emit
    // `http:server_ready`, so emit it to trigger the provider's socket.io attach
    // onto the live node server, the same code path `node ace serve` uses.
    emitter.emit('http:server_ready', { host: HOST, port: PORT, duration: [0, 0] } as any)
    await delay(200)
  })

  group.teardown(async () => {
    await dropAllTenants()
  })

  test('delivers a message only to the sender tenant and persists it in that schema', async ({
    client,
    assert,
  }) => {
    const a = await createInstalledTenant(client)
    const b = await createInstalledTenant(client)

    const clientA = await connect(a.id)
    const clientB = await connect(b.id)

    try {
      let bReceived = false
      clientB.on('chat:new', () => {
        bReceived = true
      })
      const aReceives = new Promise<any>((resolve) => clientA.on('chat:new', resolve))

      clientA.emit('chat:send', 'hello from A')

      const delivered = await Promise.race([aReceives, delay(4000).then(() => null)])
      assert.isNotNull(delivered, 'sender did not receive its own tenant broadcast')
      assert.equal(delivered.body, 'hello from A')

      // Give any (incorrect) cross-tenant delivery time to arrive before asserting.
      await delay(150)
      assert.isFalse(bReceived, 'isolation broken: tenant B received a tenant A message')

      // Persisted into tenant A's schema only.
      const tenantA = await Tenant.findOrFail(a.id)
      const tenantB = await Tenant.findOrFail(b.id)
      const rowsA = await tenancy.run(tenantA as any, () => ChatMessage.all())
      const rowsB = await tenancy.run(tenantB as any, () => ChatMessage.all())
      assert.lengthOf(rowsA, 1)
      assert.equal(rowsA[0].body, 'hello from A')
      assert.lengthOf(rowsB, 0)
    } finally {
      clientA.disconnect()
      clientB.disconnect()
    }
  }).skip(!hasWs, 'socket.io / socket.io-client not installed')

  test('rejects an unknown tenant at the handshake', async ({ assert }) => {
    const unknownId = '99999999-9999-4999-8999-999999999999'
    await assert.rejects(() => connect(unknownId))
  }).skip(!hasWs, 'socket.io / socket.io-client not installed')

  test('rejects a connection that carries no tenant id', async ({ assert }) => {
    await assert.rejects(() => connect(''))
  }).skip(!hasWs, 'socket.io / socket.io-client not installed')
})

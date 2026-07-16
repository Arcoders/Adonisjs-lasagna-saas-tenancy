import { test } from '@japa/runner'
import { HttpContext } from '@adonisjs/core/http'
import TenantAdapter from '../../../../src/models/adapters/tenant_adapter.js'
import { setConfig } from '../../../../src/config.js'
import { testConfig } from '../../../helpers/config.js'
import IsolationDriverRegistry from '../../../../src/services/isolation/registry.js'

/**
 * WS-5 / driver-contract-leaky-rowscope-noops (adapter side).
 *
 * `enforce` is an OPTIONAL hook (AD-06). When a custom driver DOES implement it,
 * the adapter must still call it on the client it resolved for the active
 * tenant. This pins that call for a driver that provides one: the adapter
 * invokes `driver.enforce?.(client, tenantId)` exactly once, with the resolved
 * client and the active tenant id, before handing the client back.
 *
 * RED (pre-fix): the adapter returned the client without an enforce hook.
 */
const UUID1 = '11111111-1111-4111-8111-111111111111'

function makeRequest(headers: Record<string, string>) {
  const h: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) h[k.toLowerCase()] = v
  return {
    hostname: () => '',
    url: () => '/',
    header: (k: string) => h[k.toLowerCase()] ?? null,
  }
}

test.group('TenantAdapter — calls driver.enforce on the resolved client', (group) => {
  let originalGet: typeof HttpContext.get

  group.each.setup(() => {
    setConfig({ ...testConfig, resolverStrategy: 'header' })
    originalGet = HttpContext.get
  })

  group.each.teardown(() => {
    ;(HttpContext as any).get = originalGet
  })

  test('enforce is invoked once with the resolved client and active tenant id', ({ assert }) => {
    const calls: Array<{ client: unknown; tenantId: string }> = []
    const driver = {
      name: 'spy',
      contractVersion: 1,
      connectionName: (id: string) => `tenant_${id}`,
      connect: async () => ({}) as any,
      disconnect: async () => {},
      destroy: async () => {},
      reset: async () => {},
      migrate: async () => ({ executed: 0, noop: true }),
      enforce: (client: unknown, tenantId: string) => calls.push({ client, tenantId }),
      tableLocation: (t: { id: string }) => ({
        kind: 'connection',
        connectionName: `tenant_${t.id}`,
      }),
    } as any
    const reg = new IsolationDriverRegistry()
    reg.register(driver, { activate: true })
    ;(HttpContext as any).get = () => ({ request: makeRequest({ 'x-tenant-id': UUID1 }) })

    const db = { connection: (name?: string) => `client:${name}` }
    const adapter = new TenantAdapter(db as any, reg)
    const result = adapter.modelConstructorClient({} as any)

    assert.lengthOf(calls, 1)
    assert.equal(calls[0]!.tenantId, UUID1)
    assert.strictEqual(calls[0]!.client, result)
  })
})

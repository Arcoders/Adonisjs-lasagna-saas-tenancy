import { test } from '@japa/runner'
import { definePlugin } from '../../../../src/sdk/define_plugin.js'
import { PLUGIN_API_CONTRACT_VERSION } from '../../../../src/sdk/plugin_api_version.js'
import { authorizerName } from '../../../../src/sdk/brands.js'
import AuthorizerRegistry, {
  type TenantAuthorizerEntry,
} from '../../../../src/services/authorizer_registry.js'
import TenantMiddlewareRegistry from '../../../../src/services/tenant_middleware_registry.js'
import CapabilityRegistry from '../../../../src/services/capability_registry.js'
import { middlewareName, capabilityKey, macroName } from '../../../../src/sdk/brands.js'
import { __resetRequestMacrosForTests } from '../../../../src/extensions/request.js'
import { HttpRequest } from '@adonisjs/core/http'
import type { SatelliteProviderContract } from '../../../../src/sdk/contract.js'
import type { ApplicationService } from '@adonisjs/core/types'

/** The facade's concrete class implements every lifecycle method; the public
 *  contract types them optional, so tests cast to Required to invoke them. */
type Lifecycle = Required<SatelliteProviderContract>

/**
 * The `definePlugin` facade. It returns a SatelliteProviderConstructor that maps
 * the declarative spec onto the provider lifecycle: register() runs bind, boot()
 * runs the ABI backstops then wires every declarative section into its registry,
 * and start/ready/shutdown run their hooks. Any section resolver or hook that
 * throws is wrapped fail-closed as a PluginBootException attributed to
 * {plugin, phase}.
 */

function makeApp(registry: AuthorizerRegistry): ApplicationService {
  return makeMultiApp({ authorizer: registry })
}

function makeMultiApp(regs: {
  authorizer?: AuthorizerRegistry
  middleware?: TenantMiddlewareRegistry
  capability?: CapabilityRegistry
}): ApplicationService {
  const authorizer = regs.authorizer ?? new AuthorizerRegistry()
  const middleware = regs.middleware ?? new TenantMiddlewareRegistry()
  const capability = regs.capability ?? new CapabilityRegistry()
  return {
    container: {
      make: async (cls: unknown) => {
        if (cls === AuthorizerRegistry) return authorizer
        if (cls === TenantMiddlewareRegistry) return middleware
        if (cls === CapabilityRegistry) return capability
        throw new Error('unexpected container.make in test')
      },
    },
  } as unknown as ApplicationService
}

const okApi = { satelliteApi: 1, pluginApiVersion: PLUGIN_API_CONTRACT_VERSION } as const

const allowEntry = (name: string): TenantAuthorizerEntry => ({
  kind: 'authorizer',
  name: authorizerName(name),
  authorize: () => ({ allow: true }),
})

test.group('definePlugin — shape', () => {
  test('returns a constructor whose instances implement the provider lifecycle', ({ assert }) => {
    const Plugin = definePlugin({ name: 'demo', ...okApi })
    const instance = new Plugin(makeApp(new AuthorizerRegistry()))
    for (const phase of ['register', 'boot', 'start', 'ready', 'shutdown'] as const) {
      assert.isFunction((instance as Record<string, unknown>)[phase])
    }
  })

  test('an unsafe plugin name is refused at definePlugin() call time', ({ assert }) => {
    assert.throws(() => definePlugin({ name: 'bad name', ...okApi }), /unsafe/)
    assert.throws(() => definePlugin({ name: 'has:colon', ...okApi }), /unsafe/)
  })
})

test.group('definePlugin — ABI backstops', () => {
  test('boot() throws when the plugin needs a NEWER satellite ABI than core provides', async ({
    assert,
  }) => {
    const Plugin = definePlugin({ name: 'demo', satelliteApi: 99 })
    const instance = new Plugin(makeApp(new AuthorizerRegistry())) as Lifecycle
    await assert.rejects(() => instance.boot(), /Satellite ABI/)
  })

  test('boot() throws when the plugin needs a NEWER facade contract than core provides', async ({
    assert,
  }) => {
    const Plugin = definePlugin({
      name: 'demo',
      satelliteApi: 1,
      pluginApiVersion: PLUGIN_API_CONTRACT_VERSION + 1,
    })
    const instance = new Plugin(makeApp(new AuthorizerRegistry())) as Lifecycle
    await assert.rejects(() => instance.boot(), /facade/)
  })
})

test.group('definePlugin — section wiring', () => {
  test('boot() registers the plugin authorizers into the AuthorizerRegistry', async ({
    assert,
  }) => {
    const registry = new AuthorizerRegistry()
    const Plugin = definePlugin({
      name: 'permissions',
      ...okApi,
      authorizers: () => [allowEntry('role_gate'), allowEntry('scope_gate')],
    })
    await (new Plugin(makeApp(registry)) as Lifecycle).boot()
    assert.deepEqual(registry.list(), ['role_gate', 'scope_gate'])
  })

  test('a section resolver that throws → PluginBootException attributed to {plugin, phase}', async ({
    assert,
  }) => {
    const Plugin = definePlugin({
      name: 'permissions',
      ...okApi,
      authorizers: () => {
        throw new Error('config missing')
      },
    })
    try {
      await (new Plugin(makeApp(new AuthorizerRegistry())) as Lifecycle).boot()
      assert.fail('boot() should have thrown')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_BOOT')
      assert.equal(err.plugin, 'permissions')
      assert.equal(err.phase, 'authorizers')
      assert.match(String(err.cause?.message), /config missing/)
    }
  })

  test('a boot() hook that throws → PluginBootException with phase "boot"', async ({ assert }) => {
    const Plugin = definePlugin({
      name: 'demo',
      ...okApi,
      boot: () => {
        throw new Error('bad config')
      },
    })
    try {
      await (new Plugin(makeApp(new AuthorizerRegistry())) as Lifecycle).boot()
      assert.fail('boot() should have thrown')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_BOOT')
      assert.equal(err.phase, 'boot')
    }
  })

  // The whole lifecycle shares #runHook, but each phase must attribute its OWN
  // phase so a deploy failure points at the right hook. A throwing hook is
  // fail-closed: it aborts (never swallowed), wrapped in a PluginBootException
  // carrying {plugin, phase}. Note register() runs the `bind` spec field but
  // reports phase "register".
  const LIFECYCLE = [
    { field: 'bind', method: 'register', phase: 'register' },
    { field: 'start', method: 'start', phase: 'start' },
    { field: 'ready', method: 'ready', phase: 'ready' },
    { field: 'shutdown', method: 'shutdown', phase: 'shutdown' },
  ] as const

  for (const { field, method, phase } of LIFECYCLE) {
    test(`a throwing ${method}() hook → PluginBootException attributed to {plugin, "${phase}"}`, async ({
      assert,
    }) => {
      const Plugin = definePlugin({
        name: 'demo',
        ...okApi,
        [field]: () => {
          throw new Error(`${phase} boom`)
        },
      })
      const instance = new Plugin(makeApp(new AuthorizerRegistry())) as Lifecycle
      try {
        await instance[method]()
        assert.fail(`${method}() should have thrown`)
      } catch (err: any) {
        assert.equal(err.code, 'E_PLUGIN_BOOT')
        assert.equal(err.plugin, 'demo')
        assert.equal(err.phase, phase)
        assert.match(String(err.cause?.message), new RegExp(`${phase} boom`))
      }
    })
  }
})

test.group('definePlugin — multi-seam dispatch', (group) => {
  group.each.teardown(() => __resetRequestMacrosForTests())

  test('boot() routes each section kind to its own seam', async ({ assert }) => {
    const authorizer = new AuthorizerRegistry()
    const middleware = new TenantMiddlewareRegistry()
    const capability = new CapabilityRegistry()
    const Plugin = definePlugin({
      name: 'omni',
      ...okApi,
      authorizers: () => [allowEntry('a1')],
      middleware: () => [
        { kind: 'middleware', name: middlewareName('m1'), middleware: { handle: () => {} } },
      ],
      provides: () => [{ kind: 'capability', name: capabilityKey('cap1'), api: { ok: true } }],
      requestMacros: () => [{ kind: 'requestMacro', name: macroName('macro1'), resolve: () => 7 }],
    })

    await (new Plugin(makeMultiApp({ authorizer, middleware, capability })) as Lifecycle).boot()

    assert.deepEqual(authorizer.list(), ['a1'])
    assert.deepEqual(middleware.list(), ['m1'])
    assert.deepEqual(capability.list(), ['cap1'])
    assert.isFunction((HttpRequest.prototype as unknown as Record<string, unknown>).macro1)
  })
})

test.group('definePlugin — lifecycle hooks', () => {
  test('register/start/ready/shutdown run their hooks with the app', async ({ assert }) => {
    const calls: string[] = []
    const app = makeApp(new AuthorizerRegistry())
    const Plugin = definePlugin({
      name: 'demo',
      ...okApi,
      bind: (a) => {
        calls.push(a === app ? 'bind:app' : 'bind:wrong')
      },
      start: () => {
        calls.push('start')
      },
      ready: () => {
        calls.push('ready')
      },
      shutdown: () => {
        calls.push('shutdown')
      },
    })
    const instance = new Plugin(app) as Lifecycle
    await instance.register()
    await instance.start()
    await instance.ready()
    await instance.shutdown()
    assert.deepEqual(calls, ['bind:app', 'start', 'ready', 'shutdown'])
  })
})

import { test } from '@japa/runner'
import { definePlugin } from '../../../../src/sdk/define_plugin.js'
import { authorizerName } from '../../../../src/sdk/brands.js'
import AuthorizerRegistry from '../../../../src/services/authorizer_registry.js'
import TenantMiddlewareRegistry from '../../../../src/services/tenant_middleware_registry.js'
import CapabilityRegistry from '../../../../src/services/capability_registry.js'
import type { SatelliteProviderContract } from '../../../../src/sdk/contract.js'
import type { ApplicationService } from '@adonisjs/core/types'

/**
 * Backwards-compatibility PINS. These two fixtures are FROZEN: they capture
 * the v1 public shapes a satellite ships against, namely the `definePlugin` facade and
 * the raw `SatelliteProviderContract` escape hatch. Later lotes grow `PluginSpec`
 * additively (schedules, onDataChange, permissions, …); this spec must keep
 * passing UNCHANGED, which proves that growth never forces an existing v1 plugin
 * to change a single line.
 *
 * The declared versions are hard-coded `1`, NOT the live constants: a real v1
 * plugin literally wrote `1`, and by the facade's three-way compat gate an older
 * declared version WARNs (still boots) rather than fails, so a future major bump
 * of the ABI/facade version must keep these booting. If a change to THIS file is
 * ever needed to make it compile or pass, that change is a breaking ABI change
 * and belongs in a major bump plus a `migrate-plugin` codemod, never a silent
 * edit here.
 */

function makeApp(regs: {
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

type Lifecycle = Required<SatelliteProviderContract>

test.group('plugin backcompat — v1 definePlugin facade keeps booting', () => {
  test('a frozen v1 facade spec registers its section and runs its lifecycle', async ({
    assert,
  }) => {
    const registry = new AuthorizerRegistry()
    const calls: string[] = []

    // The canonical v1 plugin. DO NOT edit this literal. It is the frozen shape
    // a satellite published against Lote A. It uses only fields that existed in
    // v1: name, satelliteApi, pluginApiVersion, one authorizer section, and the
    // lifecycle hooks.
    const V1_PLUGIN = definePlugin({
      name: 'legacy_v1',
      version: '1.0.0',
      satelliteApi: 1,
      pluginApiVersion: 1,
      authorizers: () => [
        { kind: 'authorizer', name: authorizerName('v1_gate'), authorize: () => ({ allow: true }) },
      ],
      bind: () => {
        calls.push('bind')
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

    const instance = new V1_PLUGIN(makeApp({ authorizer: registry })) as Lifecycle
    await instance.register()
    await instance.boot()
    await instance.start()
    await instance.ready()
    await instance.shutdown()

    assert.deepEqual(registry.list(), ['v1_gate'])
    assert.deepEqual(calls, ['bind', 'start', 'ready', 'shutdown'])
  })
})

test.group('plugin backcompat — raw SatelliteProviderContract stays alive', () => {
  test('a hand-written raw provider (no facade) runs the lifecycle and uses the same seams', async ({
    assert,
  }) => {
    const registry = new AuthorizerRegistry()
    const calls: string[] = []

    // The pre-facade route: a provider a satellite could always hand-write, and
    // exactly what `websockets` still ships to prove the raw contract lives on.
    // It reaches the same seam registry the facade wires into, so raw providers
    // and facade providers compose on equal footing.
    class RawV1Provider implements SatelliteProviderContract {
      constructor(private app: ApplicationService) {}
      async register() {
        calls.push('register')
      }
      async boot() {
        calls.push('boot')
        const authorizers = await this.app.container.make(AuthorizerRegistry)
        authorizers.register({
          kind: 'authorizer',
          name: authorizerName('raw_gate'),
          authorize: () => ({ allow: true }),
        })
      }
      async start() {
        calls.push('start')
      }
      async ready() {
        calls.push('ready')
      }
      async shutdown() {
        calls.push('shutdown')
      }
    }

    const provider = new RawV1Provider(makeApp({ authorizer: registry }))
    await provider.register()
    await provider.boot()
    await provider.start()
    await provider.ready()
    await provider.shutdown()

    assert.deepEqual(calls, ['register', 'boot', 'start', 'ready', 'shutdown'])
    assert.deepEqual(registry.list(), ['raw_gate'])
  })
})

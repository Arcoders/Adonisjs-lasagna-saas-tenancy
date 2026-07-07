import { test } from '@japa/runner'
import { definePlugin } from '../../../../src/sdk/define_plugin.js'
import { PLUGIN_API_CONTRACT_VERSION } from '../../../../src/sdk/plugin_api_version.js'
import { authorizerName, capabilityKey } from '../../../../src/sdk/brands.js'
import AuthorizerRegistry from '../../../../src/services/authorizer_registry.js'
import TenantMiddlewareRegistry from '../../../../src/services/tenant_middleware_registry.js'
import CapabilityRegistry from '../../../../src/services/capability_registry.js'
import type { SatelliteProviderContract } from '../../../../src/sdk/contract.js'
import type { ApplicationService } from '@adonisjs/core/types'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

/**
 * E6 red-team — a HOSTILE plugin authored through `definePlugin` must not subvert
 * the Lote-A request-path boundaries. Each boundary is fail-closed (it aborts the
 * deploy or denies the request), framed here from the attacker's side:
 *   1. it cannot smuggle a hostile IDENTIFIER into any section — the minter throws
 *      before it can reach a key / Symbol / DDL slot, and the facade aborts boot
 *      attributed to {plugin, phase};
 *   2. it cannot HIJACK a capability key another plugin already provides — the
 *      single-provider registry throws a typed collision and the victim's api is
 *      left intact;
 *   3. its authorizer cannot open a BACKDOOR by throwing — the chain converts a
 *      thrown authorizer to a DENY (fail-closed), never a bypass.
 *
 * SCOPE — read honestly. The in-process trust boundary is NOT a hard wall: an
 * installed plugin runs with full privilege, so the controls that actually
 * contain a hostile plugin's DATA access (a read-only Postgres role that denies
 * `User.query().delete()`, the trusted-list proxy over core singletons) are
 * Lote S and are NOT enforced here. This spec pins only the request-path surface
 * controls that exist today; it does NOT claim a malicious plugin is sandboxed.
 */

type Lifecycle = Required<SatelliteProviderContract>

const okApi = { satelliteApi: 1, pluginApiVersion: PLUGIN_API_CONTRACT_VERSION } as const

/** A fake app whose container resolves whichever plugin registries a test passes. */
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

test.group('malicious plugin — request-path boundaries stay fail-closed', () => {
  test('cannot smuggle a hostile identifier into a section (boot aborts, attributed)', async ({
    assert,
  }) => {
    const Evil = definePlugin({
      name: 'evil',
      ...okApi,
      authorizers: () => [
        {
          kind: 'authorizer',
          // `authorizerName` runs assertSafeIdentifier and throws on the ':' —
          // the attacker never gets a branded name to interpolate into a key.
          name: authorizerName('evil:injected'),
          authorize: () => ({ allow: true }),
        },
      ],
    })
    try {
      await (new Evil(makeApp({})) as Lifecycle).boot()
      assert.fail('boot() should have aborted on the hostile identifier')
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_BOOT')
      assert.equal(err.plugin, 'evil')
      assert.equal(err.phase, 'authorizers')
      assert.match(String(err.cause?.message), /unsafe/)
    }
  })

  test('cannot hijack a capability key another plugin already provides', async ({ assert }) => {
    const capability = new CapabilityRegistry()

    const Victim = definePlugin({
      name: 'mailer',
      ...okApi,
      provides: () => [
        { kind: 'capability', name: capabilityKey('email'), api: { owner: 'mailer' } },
      ],
    })
    await (new Victim(makeApp({ capability })) as Lifecycle).boot()

    const Evil = definePlugin({
      name: 'evil',
      ...okApi,
      provides: () => [
        { kind: 'capability', name: capabilityKey('email'), api: { owner: 'evil' } },
      ],
    })
    try {
      await (new Evil(makeApp({ capability })) as Lifecycle).boot()
      assert.fail('boot() should have aborted on the capability collision')
    } catch (err: any) {
      assert.equal(err.code, 'E_CAPABILITY_COLLISION')
      assert.equal(err.status, 500)
    }

    // Single-provider: the victim's api is untouched (not last-writer-wins).
    const api = capability.consume(capabilityKey('email')) as { owner: string }
    assert.equal(api.owner, 'mailer')
  })

  test('an authorizer that throws cannot open a backdoor (the chain denies)', async ({
    assert,
  }) => {
    const authorizer = new AuthorizerRegistry()
    const Evil = definePlugin({
      name: 'evil',
      ...okApi,
      authorizers: () => [
        {
          kind: 'authorizer',
          name: authorizerName('backdoor'),
          authorize: () => {
            throw new Error('let me in')
          },
        },
      ],
    })
    await (new Evil(makeApp({ authorizer })) as Lifecycle).boot()

    const ctx = { logger: { error: () => {} } } as unknown as HttpContext
    const tenant = { id: 'tenant-1' } as unknown as TenantModelContract
    const decision = await authorizer.authorizeAll(ctx, tenant)
    // The throw became a DENY, not a bypass — a hostile authorizer fails closed.
    assert.isFalse(decision.allow)
  })
})

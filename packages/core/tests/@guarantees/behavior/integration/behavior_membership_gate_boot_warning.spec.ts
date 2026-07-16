import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import MultitenancyProvider from '@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'
import { setConfig, getConfig } from '@adonisjs-lasagna/saas-tenancy'
import { createResolverStateBaseline } from '@adonisjs-lasagna/saas-tenancy/internal'

/**
 * Real provider wiring for the opt-in membership IDOR gate.
 *
 * The unit specs prove the verdict logic and that the boot branch references
 * `membershipGateRisk`. This proves the part operators actually rely on: a real
 * `provider.boot()` with a client-controlled strategy and no membership gate
 * emits EXACTLY ONE warning naming the IDOR risk, and stays silent when the
 * host wires the hook or acknowledges the risk.
 *
 * Before the fix, boot emitted zero membership warnings regardless of posture.
 */
test.group('membership-gate boot warning — real provider wiring (integration)', (group) => {
  // Capture the originals in setup and restore in an explicit `each.teardown`.
  // Returning the cleanup from setup is fragile (it never registers if the setup
  // throws before returning); an explicit teardown runs after every test, so the
  // swapped config + logger binding can never leak into the next spec.
  let restore: (() => void) | undefined

  group.each.setup(async () => {
    const originalCfg = getConfig()
    const originalLogger = await app.container.make('logger')
    // bootWith() re-runs the provider, which rewires the resolver registry chain
    // in place. Snapshot it here and restore it in teardown so a re-boot with a
    // non-header strategy cannot leak into later specs (the config-baseline guard
    // only restores the config, not the registry singleton derived from it).
    const resolverBaseline = await createResolverStateBaseline(app)
    const originalChain = resolverBaseline.capture()
    restore = () => {
      setConfig(originalCfg)
      app.config.set('multitenancy', originalCfg)
      app.container.bindValue('logger', originalLogger)
      resolverBaseline.restore(originalChain)
    }
  })

  group.each.teardown(() => {
    restore?.()
  })

  async function bootWith(overrides: Record<string, unknown>): Promise<string[]> {
    const warnings: string[] = []
    app.container.bindValue('logger', {
      warn: (msg: unknown) => warnings.push(String(msg)),
      info: () => {},
      error: () => {},
      debug: () => {},
      trace: () => {},
      fatal: () => {},
    } as any)

    const cfg = { ...getConfig(), ...overrides }
    setConfig(cfg)
    app.config.set('multitenancy', cfg)
    await new MultitenancyProvider(app).boot()
    return warnings.filter((w) => /authorizeTenantAccess|membership|IDOR/i.test(w))
  }

  test('header strategy with no hook emits exactly one membership warning', async ({ assert }) => {
    const membershipWarns = await bootWith({
      resolverStrategy: 'header',
      resolverChain: undefined,
      authorizeTenantAccess: undefined,
      acknowledgeNoMembershipGate: undefined,
    })
    assert.lengthOf(membershipWarns, 1)
  })

  test('a wired authorizeTenantAccess silences the warning', async ({ assert }) => {
    const membershipWarns = await bootWith({
      resolverStrategy: 'header',
      resolverChain: undefined,
      authorizeTenantAccess: () => true,
    })
    assert.lengthOf(membershipWarns, 0)
  })

  test('acknowledgeNoMembershipGate silences the warning', async ({ assert }) => {
    const membershipWarns = await bootWith({
      resolverStrategy: 'header',
      resolverChain: undefined,
      authorizeTenantAccess: undefined,
      acknowledgeNoMembershipGate: true,
    })
    assert.lengthOf(membershipWarns, 0)
  })

  test('a server-controlled strategy (subdomain) does not warn', async ({ assert }) => {
    const membershipWarns = await bootWith({
      resolverStrategy: 'subdomain',
      resolverChain: undefined,
      authorizeTenantAccess: undefined,
    })
    assert.lengthOf(membershipWarns, 0)
  })
})

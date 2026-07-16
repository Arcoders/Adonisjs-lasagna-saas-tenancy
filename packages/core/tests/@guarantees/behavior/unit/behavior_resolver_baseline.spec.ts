import { test } from '@japa/runner'
import { createResolverStateBaseline } from '../../../../src/testing/resolver_baseline.js'

/**
 * Unit cover for the resolver-state baseline the test harness uses to keep one
 * integration spec from poisoning another through the shared resolver registry.
 * A fake registry stands in for the container singleton so this needs no Ignitor
 * or DB: snapshot the boot chain, simulate a leak (a re-boot that rewired the
 * chain away from the header), and prove the baseline detects the drift by value
 * and restores the boot chain.
 */
function fakeApp(initialChain: string[]) {
  let chain = [...initialChain]
  const registry = {
    chain: () => [...chain],
    setChain: (names: string[]) => {
      chain = [...names]
    },
  }
  return {
    app: { container: { make: async () => registry } } as never,
    currentChain: () => [...chain],
  }
}

test.group('resolver-state baseline', () => {
  test('captures the boot chain and names itself', async ({ assert }) => {
    const { app } = fakeApp(['header'])
    const baseline = await createResolverStateBaseline(app)
    assert.equal(baseline.name, 'tenant resolver chain')
    assert.deepEqual([...baseline.capture()], ['header'])
  })

  test('detects a drifted chain by value and restores the boot chain', async ({ assert }) => {
    const fixture = fakeApp(['header'])
    const baseline = await createResolverStateBaseline(fixture.app)
    const snapshot = baseline.capture()

    // A spec re-booted the provider with a server-controlled strategy and never
    // restored the chain.
    baseline.restore(['subdomain']) // use restore as a setter to simulate the leak
    assert.deepEqual(fixture.currentChain(), ['subdomain'])
    assert.isFalse(baseline.equals(snapshot, baseline.capture()))

    baseline.restore(snapshot)
    assert.deepEqual(fixture.currentChain(), ['header'])
    assert.isTrue(baseline.equals(snapshot, baseline.capture()))
  })

  test('equals compares by value, not reference', async ({ assert }) => {
    const { app } = fakeApp(['header'])
    const baseline = await createResolverStateBaseline(app)
    assert.isTrue(baseline.equals(['a', 'b'], ['a', 'b']))
    assert.isFalse(baseline.equals(['a', 'b'], ['a']))
    assert.isFalse(baseline.equals(['a', 'b'], ['a', 'c']))
  })
})

import { test } from '@japa/runner'
import KeyProviderRegistry from '../../../../src/services/key_provider_registry.js'
import { CRYPTO_CONTRACT_VERSION } from '../../../../src/sdk/contract_version.js'
import type { KeyProvider, WrappedDek } from '../../../../src/types/key_provider.js'

/** A minimal KeyProvider double; `contractVersion` is set per test to exercise the gate. */
function fakeProvider(name: string, contractVersion?: number): KeyProvider {
  return {
    name,
    // Present the key only when a version was given: the contract's `contractVersion`
    // is optional-without-undefined, so an explicit undefined is not a valid provider.
    ...(contractVersion !== undefined ? { contractVersion } : {}),
    async wrapDek(): Promise<WrappedDek> {
      return { kekId: 'k', ciphertext: 'enc_v2:k:iv:tag:ct' }
    },
    async unwrapDek(): Promise<Buffer> {
      return Buffer.alloc(32)
    },
  }
}

// The KeyProviderRegistry mirrors the AI/billing extension gate: every provider
// declares a `contractVersion` and register() validates it via `assertContractCompat`
// at registration time. A newer contract than this build throws; an older or absent
// one registers with a one-time "unversioned" warning. resolve() is fail-closed on an
// unknown name; the platform never falls back to a weaker or shared key.
test.group('crypto KeyProviderRegistry: contract-version gate and fail-closed resolve', () => {
  test('registers a provider whose contractVersion matches the current build', ({ assert }) => {
    const registry = new KeyProviderRegistry()
    registry.register(fakeProvider('aws-kms', CRYPTO_CONTRACT_VERSION))
    assert.isTrue(registry.has('aws-kms'))
    assert.equal(registry.resolve('aws-kms').name, 'aws-kms')
  })

  test('refuses a provider built against a NEWER crypto contract (fail-closed)', ({ assert }) => {
    const registry = new KeyProviderRegistry()
    assert.throws(() => registry.register(fakeProvider('future-kms', CRYPTO_CONTRACT_VERSION + 1)))
    assert.isFalse(registry.has('future-kms'))
  })

  test('registers an UNVERSIONED provider but emits a one-time warning', ({ assert }) => {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (msg?: unknown) => warnings.push(String(msg))
    try {
      const registry = new KeyProviderRegistry()
      registry.register(fakeProvider('legacy-kms')) // no contractVersion
      assert.isTrue(registry.has('legacy-kms'))
    } finally {
      console.warn = original
    }
    assert.lengthOf(warnings, 1)
    assert.match(warnings[0]!, /legacy-kms/)
  })

  test('resolve() throws fail-closed on an unregistered provider name', ({ assert }) => {
    const registry = new KeyProviderRegistry()
    assert.throws(() => registry.resolve('nope'))
  })
})

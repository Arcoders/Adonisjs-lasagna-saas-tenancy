import { assertContractCompat } from '@adonisjs-lasagna/saas-tenancy/sdk'
import { CRYPTO_CONTRACT_VERSION } from '../sdk/contract_version.js'
import CryptoException from '../exceptions/crypto_exception.js'
import type { KeyProvider } from '../types/key_provider.js'

/**
 * The KeyProvider registry: the provider binds the built-in `env` provider here
 * at boot, and a host binds its own `aws-kms` / `hashicorp-vault` / custom
 * provider the same way. `CryptoService` resolves the ONE provider named by
 * `config.crypto.keyProvider` (default `env`). A missing name is fail-closed
 * (throws): the platform never falls back to a weaker or shared key. Stateful
 * (Map-backed), so it is a container singleton, resolved via `container.make`.
 */
export default class KeyProviderRegistry {
  #providers = new Map<string, KeyProvider>()

  /** Register a provider under its `name`. A later registration for the same name wins (a host override). */
  register(provider: KeyProvider): this {
    // Reject a provider built against a NEWER crypto contract than this build (throws);
    // an OLDER or ABSENT contractVersion registers with a one-time "unversioned" warning.
    // Version-only, at registration time, exactly as AI / billing gate their extensions.
    assertContractCompat(
      provider.contractVersion,
      CRYPTO_CONTRACT_VERSION,
      `crypto key provider "${provider.name}"`
    )
    this.#providers.set(provider.name, provider)
    return this
  }

  /** Resolve the provider for `name`, or throw fail-closed if none is registered. */
  resolve(name: string): KeyProvider {
    const provider = this.#providers.get(name)
    if (!provider) {
      throw new CryptoException(
        'keyprovider_missing',
        `[crypto] no KeyProvider is registered for '${name}'. Register it in your provider, or set config.crypto.keyProvider to a registered backend.`
      )
    }
    return provider
  }

  has(name: string): boolean {
    return this.#providers.has(name)
  }
}

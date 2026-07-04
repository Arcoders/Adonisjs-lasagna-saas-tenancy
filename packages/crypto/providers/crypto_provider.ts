import type { ApplicationService } from '@adonisjs/core/types'
import {
  assertSatelliteApiCompatAtBoot,
  type SatelliteProviderConstructor,
  type SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import { getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { assertCryptoConfig } from '../src/validate_config.js'
import type { MultitenancyConfigWithCrypto } from '../src/define_config.js'
import { DEFAULT_KEY_PROVIDER } from '../src/constants.js'
import KeyProviderRegistry from '../src/services/key_provider_registry.js'
import EnvKeyProvider from '../src/services/env_key_provider.js'
import CryptoService from '../src/services/crypto_service.js'
import PgWrappedDekStore, {
  type CryptoDb,
  type CryptoStoreDriver,
} from '../src/services/pg_wrapped_dek_store.js'

/**
 * Provider for `@adonisjs-lasagna/crypto`. Register it in the host's
 * `adonisrc.ts` alongside the core `MultitenancyProvider` (the configure hook
 * does this for you). It obeys the platform rules: core is resolved through
 * `app.container.make`, never `new`-ed, and the dependency only goes satellite to
 * core. `boot()` validates the `crypto` config block eagerly so a bad shape fails
 * at startup rather than at the first encrypted write.
 */
export default class CryptoProvider implements SatelliteProviderContract {
  constructor(protected app: ApplicationService) {}

  register() {
    // The KeyProvider registry, with the built-in env provider registered by
    // default (§12.1). A host binds its own aws-kms / hashicorp-vault / custom
    // provider by resolving this registry and calling `register(...)` in its own
    // provider. Stateful (Map-backed): a container singleton, never new-ed ad hoc.
    this.app.container.singleton(KeyProviderRegistry, () => {
      return new KeyProviderRegistry().register(new EnvKeyProvider())
    })

    // The field-encryption core. It resolves the ONE KeyProvider named by
    // `config.crypto.keyProvider` (default env) and drives the per-tenant
    // wrapped-DEK table through the Pg store, which asks the active driver
    // `tableLocation(tenant)` for placement (never a hardcoded schema) and
    // re-asserts the active tenancy scope on every raw query (the satellite
    // ContextSeal). The `'lucid.db'` alias is resolved like the AI vector store,
    // so the satellite adds no direct lucid dependency.
    this.app.container.singleton(CryptoService, async (resolver) => {
      const crypto = this.app.config.get<MultitenancyConfigWithCrypto>('multitenancy')?.crypto
      const registry = await resolver.make(KeyProviderRegistry)
      const keyProvider = registry.resolve(crypto?.keyProvider ?? DEFAULT_KEY_PROVIDER)
      const store = new PgWrappedDekStore({
        getDriver: () => getActiveDriver() as Promise<CryptoStoreDriver>,
        getDb: async () =>
          (await this.app.container.make('lucid.db' as never)) as unknown as CryptoDb,
        activeScopeTenantId: () => tenancy.currentId(),
      })
      return new CryptoService({ keyProvider, store })
    })
  }

  async boot() {
    // Runtime ABI backstop (satelliteApi mirrors package.json#lasagnaSatellite).
    // Fail fast on a core too old.
    assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, '@adonisjs-lasagna/crypto')

    const config = this.app.config.get<MultitenancyConfigWithCrypto>('multitenancy')
    assertCryptoConfig(config?.crypto)
  }
}

// Compile-time ABI pin: fail the build if the provider drifts from the public
// satellite constructor contract (same guard the AI / billing providers use).
const _satelliteAbiPin: SatelliteProviderConstructor = CryptoProvider
void _satelliteAbiPin

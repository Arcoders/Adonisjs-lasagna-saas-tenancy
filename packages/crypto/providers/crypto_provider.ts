import type { ApplicationService } from '@adonisjs/core/types'
import {
  assertSatelliteApiCompatAtBoot,
  type SatelliteProviderConstructor,
  type SatelliteProviderContract,
} from '@adonisjs-lasagna/saas-tenancy/sdk'
import { getActiveDriver } from '@adonisjs-lasagna/saas-tenancy/services'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import WormLedgerWriter, { type WormDb } from '@adonisjs-lasagna/saas-tenancy/worm-ledger'
import { assertCryptoConfig } from '../src/validate_config.js'
import type { MultitenancyConfigWithCrypto } from '../src/define_config.js'
import { DEFAULT_KEY_PROVIDER } from '../src/constants.js'
import KeyProviderRegistry from '../src/services/key_provider_registry.js'
import EnvKeyProvider from '../src/services/env_key_provider.js'
import CryptoService from '../src/services/crypto_service.js'
import RekekService from '../src/services/rekek_service.js'
import EncryptedRepository from '../src/services/encrypted_repository.js'
import WormShredLedger from '../src/services/worm_shred_ledger.js'
import { withCryptoOperationLock } from '../src/internal/operation_lock.js'
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
      const makeDb = () => this.app.container.make('lucid.db' as never)
      const activeScopeTenantId = () => tenancy.currentId()
      const store = new PgWrappedDekStore({
        getDriver: () => getActiveDriver() as Promise<CryptoStoreDriver>,
        getDb: async () => (await makeDb()) as unknown as CryptoDb,
        activeScopeTenantId,
      })
      // The two-phase shred audit: the shared core WORM ledger (per-tenant hash
      // chain in backoffice, append-only), wrapped as a ShredLedger. The
      // erasability gate is wired from governance's config seam (absent ⇒ shred is
      // fail-closed refused, I7). encrypt/decrypt do not depend on either.
      const ledger = new WormShredLedger(
        new WormLedgerWriter({
          getDb: async () => (await makeDb()) as unknown as WormDb,
          connectionName: 'backoffice',
          activeScopeTenantId,
        })
      )
      return new CryptoService({
        keyProvider,
        store,
        erasabilityResolver: crypto?.erasabilityResolver,
        ledger,
        // The per-tenant operation lock (I10): provision + shred serialize on it so
        // two concurrent writers to one (subject × category) DEK cannot interleave.
        // Redis-backed, fail-open on a Redis outage (the partial UNIQUE is the real
        // singularity guarantee).
        withLock: withCryptoOperationLock,
      })
    })

    // The KEK-rotation walker (I8, §6.7), driving `tenant:crypto:rekek`. It shares
    // the same KeyProvider + Pg store wiring as CryptoService (a fresh store: the
    // store is stateless behind its injected deps), and re-wraps DEKs under the
    // current KEK generation without ever decrypting a field value. Resolved via
    // `container.make(RekekService)` by the ace command.
    this.app.container.singleton(RekekService, async (resolver) => {
      const crypto = this.app.config.get<MultitenancyConfigWithCrypto>('multitenancy')?.crypto
      const registry = await resolver.make(KeyProviderRegistry)
      const keyProvider = registry.resolve(crypto?.keyProvider ?? DEFAULT_KEY_PROVIDER)
      const makeDb = () => this.app.container.make('lucid.db' as never)
      const store = new PgWrappedDekStore({
        getDriver: () => getActiveDriver() as Promise<CryptoStoreDriver>,
        getDb: async () => (await makeDb()) as unknown as CryptoDb,
        activeScopeTenantId: () => tenancy.currentId(),
      })
      return new RekekService({ keyProvider, store })
    })

    // The explicit field-encryption surface (§6.4, Option B): a context-aware
    // facade over CryptoService that resolves the CURRENT tenant per call, so the
    // caller passes only `(subject, category)` and the value. Resolved via
    // `container.make(EncryptedRepository)` (the typed equivalent of the design's
    // illustrative `'crypto.repository'` string). Fail-closed with no tenant scope.
    this.app.container.singleton(EncryptedRepository, async (resolver) => {
      return new EncryptedRepository({
        crypto: await resolver.make(CryptoService),
        resolveCurrentTenant: () => tenancy.current(),
      })
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

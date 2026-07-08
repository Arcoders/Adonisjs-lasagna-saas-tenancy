import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { resolveLucidDb } from '@adonisjs-lasagna/saas-tenancy/sdk'
import { getActiveDriver, MetricsService } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig } from '@adonisjs-lasagna/saas-tenancy/config'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import { setCryptoGuardMetricSink } from '../src/isthmus/crypto_guard_audit.js'
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
 * Provider for `@adonisjs-lasagna/crypto`, built with the {@link definePlugin}
 * facade. Register it in the host's `adonisrc.ts` alongside the core
 * `MultitenancyProvider` (the configure hook does this for you). It obeys the
 * platform rules: core is resolved through `app.container.make`, never `new`-ed,
 * and the dependency only goes satellite to core.
 *
 * The facade wires the ABI backstops (the Satellite ABI + the plugin-API contract)
 * inside its own `boot()`, so this file declares only what crypto actually does:
 *  - `bind` binds the KeyProvider registry, the field-encryption core, the
 *    KEK-rotation walker, and the explicit encrypt/decrypt facade (this is
 *    `register()`).
 *  - `boot` validates the `crypto` config block eagerly so a bad shape fails at
 *    startup rather than at the first encrypted write.
 *  - `ready` bridges tenantful crypto guard trips to the per-tenant metric rail,
 *    resolved once the core singletons are wired.
 *  - `shutdown` tears that metric sink back down. (Under the raw provider this was
 *    a stray `disconnect()` that AdonisJS never calls, so the sink leaked; the
 *    facade's `shutdown` maps onto the real lifecycle hook.)
 */
export default definePlugin({
  name: 'crypto',
  packageName: '@adonisjs-lasagna/crypto',
  // Mirrors package.json#lasagnaSatellite.satelliteApi (check-abi-boot-assertion
  // pins these against each other so the literal can't drift).
  satelliteApi: 1,
  // The definePlugin facade contract this satellite was built against.
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  bind(app) {
    // The KeyProvider registry, with the built-in env provider registered by
    // default (§12.1). A host binds its own aws-kms / hashicorp-vault / custom
    // provider by resolving this registry and calling `register(...)` in its own
    // provider. Stateful (Map-backed): a container singleton, never new-ed ad hoc.
    app.container.singleton(KeyProviderRegistry, () => {
      return new KeyProviderRegistry().register(new EnvKeyProvider())
    })

    // The field-encryption core. It resolves the ONE KeyProvider named by
    // `config.crypto.keyProvider` (default env) and drives the per-tenant
    // wrapped-DEK table through the Pg store, which asks the active driver
    // `tableLocation(tenant)` for placement (never a hardcoded schema) and
    // re-asserts the active tenancy scope on every raw query (the satellite
    // ContextSeal). The `'lucid.db'` alias is resolved like the AI vector store,
    // so the satellite adds no direct lucid dependency.
    app.container.singleton(CryptoService, async (resolver) => {
      const crypto = app.config.get<MultitenancyConfigWithCrypto>('multitenancy')?.crypto
      const registry = await resolver.make(KeyProviderRegistry)
      const keyProvider = registry.resolve(crypto?.keyProvider ?? DEFAULT_KEY_PROVIDER)
      const makeDb = () => resolveLucidDb(app)
      const activeScopeTenantId = () => tenancy.currentId()
      const store = new PgWrappedDekStore({
        getDriver: () => getActiveDriver() as Promise<CryptoStoreDriver>,
        getDb: async () => (await makeDb()) as unknown as CryptoDb,
        activeScopeTenantId,
      })
      // The two-phase shred audit: the shared core WORM ledger (per-tenant hash
      // chain in the backoffice schema, append-only), wrapped as a ShredLedger. The
      // erasability gate is wired from governance's config seam (absent ⇒ shred is
      // fail-closed refused, I7). encrypt/decrypt do not depend on either. Both the
      // schema and the connection are resolved from config (never a hardcoded
      // literal): the ledger's SQL is qualified through qualifyBackofficeTable with
      // `backofficeSchemaName`, and it runs on `backofficeConnectionName` — the
      // convention core uses for every backoffice-schema table — so a host that
      // separates or renames its backoffice schema/connection is honored.
      const ledger = new WormShredLedger(
        new WormLedgerWriter({
          getDb: async () => (await makeDb()) as unknown as WormDb,
          connectionName: getConfig().backofficeConnectionName,
          schemaName: getConfig().backofficeSchemaName,
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
    app.container.singleton(RekekService, async (resolver) => {
      const crypto = app.config.get<MultitenancyConfigWithCrypto>('multitenancy')?.crypto
      const registry = await resolver.make(KeyProviderRegistry)
      const keyProvider = registry.resolve(crypto?.keyProvider ?? DEFAULT_KEY_PROVIDER)
      const makeDb = () => resolveLucidDb(app)
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
    app.container.singleton(EncryptedRepository, async (resolver) => {
      return new EncryptedRepository({
        crypto: await resolver.make(CryptoService),
        resolveCurrentTenant: () => tenancy.current(),
      })
    })
  },

  boot(app) {
    const config = app.config.get<MultitenancyConfigWithCrypto>('multitenancy')
    assertCryptoConfig(config?.crypto)
  },

  async ready(app) {
    // Bridge tenantful crypto guard trips to the per-tenant integer-metric rail
    // (`crypto_guard_rejections`), mirroring the AI provider. Resolved in ready(),
    // when the core singletons are wired. Fire-and-forget inside the audit module, so
    // a slow metric write never touches a reject path.
    const metrics = await app.container.make(MetricsService)
    setCryptoGuardMetricSink((tenantId, name, value) => metrics.emitMetric(tenantId, name, value))
  },

  shutdown() {
    setCryptoGuardMetricSink(undefined)
  },
})

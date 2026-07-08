/**
 * Public surface for building packaged Lasagna satellites. See the
 * "Creating a satellite" cookbook for the full guide.
 *
 *  - `SatelliteManifest` / `readSatelliteManifest` — the declarative
 *    `package.json#lasagnaSatellite` contract.
 *  - `SatelliteProviderContract` — the provider lifecycle a satellite implements.
 *  - the configure toolkit (`discoverSatellites`, `publishSatellite`,
 *    `registerSatelliteInRcFile`, `printSatelliteManifest`, …) used by both
 *    core's `configure` and a satellite's own `adonisjs.configure` hook.
 */
export type { SatelliteManifest, SatelliteDependency, DiscoveredSatellite } from './manifest.js'
export { readSatelliteManifest, isSafeRelativePath } from './manifest.js'

export type { SatelliteProviderContract, SatelliteProviderConstructor } from './contract.js'

export {
  SATELLITE_API_VERSION,
  checkSatelliteApiCompat,
  assertSatelliteApiCompatAtBoot,
} from './api_version.js'
export type { SatelliteApiCompat } from './api_version.js'

/**
 * Per-surface extension contract versioning — one level below the Satellite
 * ABI. A satellite's extension registry calls `assertContractCompat` in its
 * `register()` to reject incompatible extensions at registration time. Pure +
 * bare-safe, so it works from a satellite's own unit runner.
 */
export {
  compareContractVersion,
  checkContractCompat,
  assertContractCompat,
} from './contract_version.js'
export type { ContractCompatLevel } from './contract_version.js'

export { resolveSatelliteDependencies, satisfiesRange } from './dependencies.js'
export type { DependencyResolution } from './dependencies.js'

/**
 * Pure tenant-id validators a satellite needs whenever it interpolates a tenant
 * id into SQL/DDL or reads one off a request/handshake. Bare-safe (no booted
 * import), so they are usable from a satellite's own unit runner — this is the
 * stable home for satellite authors. (`assertSafeIdentifier` is also on
 * `/services` for in-app custom-driver authors.)
 */
export { isUuidV4, assertSafeIdentifier } from '../services/isolation/identifier.js'

/**
 * Build a SQL-safe `"schema"."table"` reference for a table in the shared backoffice
 * schema, honoring `config.backofficeSchemaName`. A satellite that writes raw SQL to
 * a backoffice table (a hash-chain ledger, an audit trail) uses this instead of a
 * hardcoded `backoffice.` prefix, so a host that renames the schema is honored. Pure
 * + bare-safe.
 */
export { qualifyBackofficeTable } from '../utils/backoffice_table.js'

/**
 * Bootstrap-time environment helpers a satellite provider needs before the app is
 * fully booted. `isProductionNodeEnv` matches the framework's prod/production
 * normalization (a security gate must not diverge from `app.inProduction`), and
 * `readBooleanEnvFlag` is the single normalized parse for a boolean toggle (so a
 * value typo/case never silently picks the safe branch). Both are bare-safe.
 */
export { isProductionNodeEnv, readBooleanEnvFlag } from '../utils/env.js'

/**
 * Resolve the Lucid `Database` from the container without repeating the
 * `'lucid.db' as never` cast at every satellite provider. A caller narrows the result
 * to the query surface it uses (a raw-SQL writer, a store).
 */
export { resolveLucidDb } from '../utils/lucid_db.js'

export type { CodemodsLike, LoggerLike } from './configure_kit.js'
export {
  filterAlreadyPublished,
  listExistingMigrations,
  discoverSatellites,
  indexSatellites,
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  migrationSlug,
} from './configure_kit.js'

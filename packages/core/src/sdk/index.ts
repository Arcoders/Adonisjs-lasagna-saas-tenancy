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
export type { SatelliteManifest, DiscoveredSatellite } from './manifest.js'
export { readSatelliteManifest, isSafeRelativePath } from './manifest.js'

export type { SatelliteProviderContract, SatelliteProviderConstructor } from './contract.js'

export { SATELLITE_API_VERSION, checkSatelliteApiCompat } from './api_version.js'
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

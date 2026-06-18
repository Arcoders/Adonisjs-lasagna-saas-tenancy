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

export type { CodemodsLike, LoggerLike } from './configure_kit.js'
export {
  filterAlreadyPublished,
  listExistingMigrations,
  discoverSatellites,
  indexSatellites,
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
} from './configure_kit.js'

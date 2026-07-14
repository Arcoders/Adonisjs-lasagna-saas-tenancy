import type { SatelliteManifest } from './manifest.js'

/**
 * Version surfaces: there is NO umbrella version.
 *
 * Lasagna's public contract is versioned along independent axes, each bumped only
 * for a change an author building against THAT axis could observe. There is
 * deliberately no single "framework version" that gates everything, because
 * aliasing two axes forces one kind of change to masquerade as another (a facade
 * tweak posing as an ABI bump, or hiding behind one) and desensitizes the compat
 * warning of whichever axis it was folded into.
 *
 *  - {@link SATELLITE_API_VERSION} (this file): the Satellite ABI, the core
 *    registries/manifest/lifecycle a satellite self-registers into. Declared via
 *    `package.json#lasagnaSatellite.satelliteApi`; gated at configure + boot.
 *  - `PLUGIN_API_CONTRACT_VERSION` (./plugin_api_version.js): the `definePlugin`
 *    facade contract. Declared via `definePlugin({ pluginApiVersion })`, mirrored
 *    in `package.json#lasagnaSatellite.pluginApiVersion`.
 *  - per-surface `*_CONTRACT_VERSION` (one per extension registry: resolver,
 *    isolation, capability, authorizer, …): the shape of THAT registry's entry +
 *    protocol. Declared via the entry's `contractVersion`, compared by
 *    `assertContractCompat` (./contract_version.js) at registration.
 *  - the published (marketing) npm `version`: never conflated with any of the above.
 *
 * `nativeAddons` is NOT a version. It is a boolean capability flag (does the
 * plugin ship a `.node` addon?) mirrored between the facade and manifest the same
 * way and enforced fail-closed at boot by `assertNativeAddonsSandboxable`.
 * `check-abi-boot-assertion` pins the boot-time literals of these surfaces against
 * the manifest so they cannot drift; `check-extension-contracts` pins the
 * per-surface constants.
 */

/**
 * The Satellite ABI version: a single monotonic integer identifying the shape
 * of the public extension surface a satellite builds against: the core
 * registries it self-registers into (`HookRegistry`, `DoctorService`,
 * `IsolationDriverRegistry`, `TenantResolverRegistry`, the queue `Locator`, the
 * emitter), the manifest + configure toolkit, and the provider lifecycle.
 *
 * It is bumped whenever that surface changes in a way a satellite could observe,
 * INDEPENDENTLY of the package's published (marketing) version. A satellite
 * declares the ABI it was built against via
 * `package.json#lasagnaSatellite.satelliteApi`; `configure` compares the two
 * through {@link checkSatelliteApiCompat} before wiring the satellite into the
 * host.
 *
 * Treat this integer as a major: any backward-incompatible change to the
 * surface above is a bump. Additive, backward-compatible changes do NOT bump it.
 */
export const SATELLITE_API_VERSION = 1

export type SatelliteApiCompat =
  | { level: 'ok' }
  | { level: 'warn'; message: string }
  | { level: 'fail'; message: string }

/**
 * Compare a satellite's declared `satelliteApi` against the core's
 * {@link SATELLITE_API_VERSION}. Pure (no fs, no logger import) so both core's
 * `configure` and a satellite's own configure hook / provider `boot()` can call
 * it.
 *
 *  - satellite needs a NEWER ABI than this core provides: `fail` (refuse to wire).
 *  - satellite built for an OLDER ABI: `warn` (surface may have changed under it).
 *  - equal: `ok`.
 *  - absent: `warn` (compatibility unverified; pre-versioning satellites).
 */
export function checkSatelliteApiCompat(
  manifest: Pick<SatelliteManifest, 'satelliteApi'>,
  packageName: string,
  coreApiVersion: number = SATELLITE_API_VERSION
): SatelliteApiCompat {
  const declared = manifest.satelliteApi

  if (declared === undefined) {
    return {
      level: 'warn',
      message:
        `${packageName} does not declare "lasagnaSatellite.satelliteApi"; ` +
        `compatibility with this core's Satellite ABI v${coreApiVersion} is unverified.`,
    }
  }

  if (declared > coreApiVersion) {
    return {
      level: 'fail',
      message:
        `${packageName} requires Satellite ABI v${declared}, but this core provides ` +
        `v${coreApiVersion}. Upgrade @adonisjs-lasagna/saas-tenancy to use this satellite.`,
    }
  }

  if (declared < coreApiVersion) {
    return {
      level: 'warn',
      message:
        `${packageName} was built for Satellite ABI v${declared}; this core is ` +
        `v${coreApiVersion}. It may rely on extension surface that has since changed — ` +
        `check the satellite's changelog before relying on it.`,
    }
  }

  return { level: 'ok' }
}

/**
 * Enforce {@link checkSatelliteApiCompat} at satellite `boot()` time: throw on
 * `fail` (the running core is too old for this satellite, so fail fast before any
 * feature code runs), surface `warn` through `onWarn` (defaults to `console.warn`,
 * the same fallback the registries use), do nothing on `ok`.
 *
 * `configure` already gates ABI at install time ({@link checkSatelliteApiCompat}
 * via `partitionSatellitesByApiCompat`), but that only runs once, at scaffold
 * time. A later `npm i @adonisjs-lasagna/saas-tenancy@older` downgrades the core
 * underneath an already-configured satellite with no re-check, so each satellite
 * provider calls this at boot as the runtime backstop. Pure (no fs/app import) so
 * a provider can call it synchronously; pass a logger-backed `onWarn` if desired.
 */
export function assertSatelliteApiCompatAtBoot(
  manifest: Pick<SatelliteManifest, 'satelliteApi'>,
  packageName: string,
  onWarn: (message: string) => void = (m) => console.warn(`[lasagna] ${m}`),
  coreApiVersion: number = SATELLITE_API_VERSION
): void {
  const result = checkSatelliteApiCompat(manifest, packageName, coreApiVersion)
  if (result.level === 'fail') throw new Error(result.message)
  if (result.level === 'warn') onWarn(result.message)
}

import { assertContractCompat } from './contract_version.js'

/**
 * The Plugin API contract version: a single monotonic integer identifying the
 * shape of the `definePlugin()` facade and its section contracts (the `/plugin`
 * surface). It is INDEPENDENT of the Satellite ABI ({@link ./api_version.js}) and
 * of the package's published (marketing) version.
 *
 * Why independent (reversing the round-1 alias): the facade can evolve
 * (a new required section field, a changed builder signature) WITHOUT touching
 * the raw {@link ./contract.js SatelliteProviderContract} ABI that hand-written
 * providers build against, and vice-versa. Aliasing the two would force a facade
 * bump to masquerade as an ABI bump (or hide behind one). A plugin declares the
 * facade contract it was built against via `definePlugin({ pluginApiVersion })`
 * (mirrored in `package.json#lasagnaSatellite.pluginApiVersion`).
 *
 * Treat this integer as a major: any backward-incompatible change to the facade
 * surface bumps it; additive, backward-compatible changes do NOT.
 */
export const PLUGIN_API_CONTRACT_VERSION = 1

/**
 * Public alias re-exported from `/plugin`, the name a plugin author reads and
 * declares against. Kept as a named constant (not an inline literal) so the value
 * has one home.
 */
export const LASAGNA_PLUGIN_API_VERSION = PLUGIN_API_CONTRACT_VERSION

/**
 * Enforce facade-contract compatibility at plugin `boot()`. Reuses the existing
 * three-way {@link assertContractCompat} (no bespoke semver-range parser): a
 * plugin needing a NEWER facade than this core provides `fail`s (throws to abort
 * the deploy, fail-closed), an OLDER declared version `warn`s (the facade may
 * have changed under it), an undeclared version `warn`s (unverified), equal is
 * `ok`. `label` names the offending plugin in the message.
 */
export function assertPluginApiCompatAtBoot(
  pluginApiVersion: number | undefined,
  label: string,
  onWarn: (message: string) => void = (m) => console.warn(`[lasagna] ${m}`)
): void {
  assertContractCompat(
    pluginApiVersion,
    PLUGIN_API_CONTRACT_VERSION,
    `plugin "${label}" facade`,
    onWarn
  )
}

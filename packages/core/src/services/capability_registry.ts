import { assertContractCompat } from '../sdk/contract_version.js'
import { isTrustedSatellite } from '../sdk/plugin_env.js'
import { pluginScope } from './plugin_execution_scope.js'
import { emitIsthmusEvent } from '../isthmus/audit.js'
import type { CapabilityKey, PluginName } from '../sdk/brands.js'
import type { LasagnaCapabilities } from '../sdk/capabilities.js'
import CapabilityCollisionException from '../exceptions/capability_collision_exception.js'
import CapabilityTrustException from '../exceptions/capability_trust_exception.js'

/**
 * The capability-registry contract version: the shape of {@link CapabilityProvision}
 * and the `provide`/`consume` protocol. Bump as a MAJOR only for a backward-incompatible
 * change. INDEPENDENT of `satelliteApi`, the facade `pluginApiVersion`, and the
 * published version (a cross-plugin provide/consume contract earns its own constant).
 *
 * Stays at 1. The `sensitive?` trust flag was added ADDITIVELY: a provision that never
 * sets it behaves exactly as before, and one that opts in gets the `TRUSTED_SATELLITES`
 * gate for free. An additive change must NOT bump the integer — `assertContractCompat`
 * WARNS every extension built against an older version, so a spurious bump floods that
 * channel with false alarms and desensitizes operators to the genuinely breaking bumps
 * (isolation's v2 `tableLocation` requirement) that need the warning read.
 */
export const CAPABILITY_CONTRACT_VERSION = 1

/**
 * A capability a plugin provides. Discriminated by `kind`, all fields
 * `readonly`. `name` is branded (minted via `capabilityKey()`); `api` is the
 * object a consumer gets back, typed at the `consume` site via {@link LasagnaCapabilities}.
 */
export interface CapabilityProvision {
  readonly kind: 'capability'
  readonly name: CapabilityKey
  readonly api: unknown
  /**
   * Opt this capability into the trust gate. When `true`, only a plugin on the
   * `TRUSTED_SATELLITES` allowlist may `provide` it, and only trusted code (core or
   * a trusted plugin) may `consume` it. An untrusted attempt throws
   * {@link CapabilityTrustException}. Default (`undefined`/`false`): freely composable.
   */
  readonly sensitive?: boolean
  /** Contract version this provision was built against (see {@link CAPABILITY_CONTRACT_VERSION}). */
  readonly contractVersion?: number
}

interface StoredCapability {
  readonly api: unknown
  readonly sensitive: boolean
}

/**
 * Registry for OPTIONAL, degradable cross-plugin composition. Bound as a container
 * singleton by `MultitenancyProvider`; plugins `register` (provide) in their
 * `boot()` and any code `consume`s at runtime. Map-backed (stateful): resolve via
 * `container.make`, never `new`.
 *
 * SINGLE-provider: two plugins providing the same key is a deploy-time conflict
 * ({@link CapabilityCollisionException}), not last-writer-wins. A `consume(key)`
 * must be unambiguous. `consume` returns `undefined` when the capability is
 * absent, so a consumer degrades gracefully ("use it if installed").
 *
 * SENSITIVE capabilities (`sensitive: true`) additionally cross a trust gate:
 * an untrusted plugin cannot provide or consume one. This is labeled in-process
 * friction (an installed plugin has full reach) that makes the trusted/untrusted
 * split explicit at the composition seam. See `.github/SECURITY.md`.
 */
export default class CapabilityRegistry {
  readonly #caps = new Map<string, StoredCapability>()

  /** The capability-contract version this surface implements. */
  get contractVersion(): number {
    return CAPABILITY_CONTRACT_VERSION
  }

  /**
   * Provide a capability. Throws on a duplicate key, an incompatible contract, or
   * (for a `sensitive` capability) a `providerName` not on the trusted allowlist.
   * `providerName` is the registering plugin's `definePlugin({ name })`; the facade
   * threads it in. A sensitive provision with no providerName (a hand-registration
   * that cannot be attributed) fails closed.
   */
  register(entry: CapabilityProvision, providerName?: PluginName): this {
    if (this.#caps.has(entry.name)) {
      throw new CapabilityCollisionException(
        `Capability "${entry.name}" is already provided; two plugins cannot provide one key.`,
        { plugin: entry.name }
      )
    }
    assertContractCompat(
      entry.contractVersion,
      CAPABILITY_CONTRACT_VERSION,
      `capability "${entry.name}"`
    )
    if (
      entry.sensitive === true &&
      !(providerName !== undefined && isTrustedSatellite(providerName))
    ) {
      const attributed = providerName ?? '(unattributed)'
      emitIsthmusEvent('guard.plugin_capability_trust', {
        metadata: { plugin: attributed, capability: entry.name, direction: 'provide' },
      })
      throw new CapabilityTrustException(
        `refusing to provide sensitive capability "${entry.name}" from untrusted plugin "${attributed}"`,
        { plugin: providerName }
      )
    }
    this.#caps.set(entry.name, { api: entry.api, sensitive: entry.sensitive === true })
    return this
  }

  /**
   * Read a capability's api, or `undefined` when absent (degradable). The typed
   * overload keys on {@link LasagnaCapabilities} so `consume('email')` is
   * `EmailApi | undefined` in a compilation that augmented it; a branded/opaque
   * key falls to `unknown`.
   *
   * A SENSITIVE capability consumed from inside an UNTRUSTED plugin execution scope
   * throws {@link CapabilityTrustException} (fail-closed) rather than degrading:
   * an untrusted plugin reaching a sensitive api is an attack, not an absence.
   */
  consume<K extends keyof LasagnaCapabilities & string>(name: K): LasagnaCapabilities[K] | undefined
  consume(name: CapabilityKey): unknown
  consume(name: string): unknown {
    const record = this.#caps.get(name)
    if (record === undefined) return undefined
    if (record.sensitive && pluginScope.untrustedActive()) {
      const attributed = pluginScope.current()?.plugin ?? '(unknown)'
      emitIsthmusEvent('guard.plugin_capability_trust', {
        metadata: { plugin: attributed, capability: name, direction: 'consume' },
      })
      throw new CapabilityTrustException(
        `refusing to let untrusted plugin "${attributed}" consume sensitive capability "${name}"`,
        { plugin: pluginScope.current()?.plugin }
      )
    }
    return record.api
  }

  has(name: CapabilityKey | string): boolean {
    return this.#caps.has(name)
  }

  list(): readonly string[] {
    return [...this.#caps.keys()]
  }
}

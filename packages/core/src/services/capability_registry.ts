import { assertContractCompat } from '../sdk/contract_version.js'
import type { CapabilityKey } from '../sdk/brands.js'
import type { LasagnaCapabilities } from '../sdk/capabilities.js'
import CapabilityCollisionException from '../exceptions/capability_collision_exception.js'

/**
 * The capability-registry contract version: the shape of {@link CapabilityProvision}
 * and the `provide`/`consume` protocol. Bump as a MAJOR for a backward-incompatible
 * change. INDEPENDENT of `satelliteApi`, the facade `pluginApiVersion`, and the
 * published version (plan: a cross-plugin provide/consume contract → its own constant).
 */
export const CAPABILITY_CONTRACT_VERSION = 1

/**
 * A capability a plugin provides. Discriminated by `kind` (E1), all fields
 * `readonly`. `name` is branded (minted via `capabilityKey()`); `api` is the
 * object a consumer gets back, typed at the `consume` site via {@link LasagnaCapabilities}.
 */
export interface CapabilityProvision {
  readonly kind: 'capability'
  readonly name: CapabilityKey
  readonly api: unknown
  /** Contract version this provision was built against (see {@link CAPABILITY_CONTRACT_VERSION}). */
  readonly contractVersion?: number
}

/**
 * Registry for OPTIONAL, degradable cross-plugin composition. Bound as a container
 * singleton by `MultitenancyProvider`; plugins `register` (provide) in their
 * `boot()` and any code `consume`s at runtime. Map-backed (stateful): resolve via
 * `container.make`, never `new`.
 *
 * SINGLE-provider: two plugins providing the same key is a deploy-time conflict
 * ({@link CapabilityCollisionException}), not last-writer-wins — a `consume(key)`
 * must be unambiguous. `consume` returns `undefined` when the capability is
 * absent, so a consumer degrades gracefully ("use it if installed").
 */
export default class CapabilityRegistry {
  readonly #caps = new Map<string, unknown>()

  /** The capability-contract version this surface implements. */
  get contractVersion(): number {
    return CAPABILITY_CONTRACT_VERSION
  }

  /** Provide a capability. Throws on a duplicate key or incompatible contract. */
  register(entry: CapabilityProvision): this {
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
    this.#caps.set(entry.name, entry.api)
    return this
  }

  /**
   * Read a capability's api, or `undefined` when absent (degradable). The typed
   * overload keys on {@link LasagnaCapabilities} so `consume('email')` is
   * `EmailApi | undefined` in a compilation that augmented it; a branded/opaque
   * key falls to `unknown`.
   */
  consume<K extends keyof LasagnaCapabilities & string>(name: K): LasagnaCapabilities[K] | undefined
  consume(name: CapabilityKey): unknown
  consume(name: string): unknown {
    return this.#caps.get(name)
  }

  has(name: CapabilityKey | string): boolean {
    return this.#caps.has(name)
  }

  list(): readonly string[] {
    return [...this.#caps.keys()]
  }
}

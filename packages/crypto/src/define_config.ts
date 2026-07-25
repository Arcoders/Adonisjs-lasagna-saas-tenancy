import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey } from './types/key_provider.js'
import type { ErasabilityResolver } from './types/erasability.js'

/**
 * An encrypted-field declaration: which governance {@link CategoryKey} a field's
 * value belongs to (so it derives that category's DEK), and whether it carries a
 * deterministic search HMAC (a blind index). Indexing is opt-in per field because
 * the blind index leaks equality and frequency to a DB reader, so a host opts a
 * field in deliberately.
 */
export interface CryptoFieldConfig {
  /** The processing category whose per-`(subject × category)` DEK seals this field. */
  category: CategoryKey
  /** Build a keyed-HMAC blind index for equality search on this field. Default false. */
  searchable?: boolean
}

/**
 * crypto satellite config. Opt-in via `--with=crypto` and declaring
 * `config.crypto`. crypto is a mechanism: it carries no policy (no category
 * registry, no consent, no retention). It only needs to know which KeyProvider
 * backs the KEK and which category each encrypted field belongs to.
 */
export interface CryptoConfig {
  /**
   * The KeyProvider backend name resolved from the registry. Default `'env'`
   * (dev-grade, KEK derived from `APP_KEY`). Prod binds `'aws-kms'` or
   * `'hashicorp-vault'` (or a custom provider) in its own provider and names it
   * here; an unregistered name is fail-closed at resolve time.
   */
  keyProvider?: string
  /**
   * The encrypted-field/category registry: which category each encrypted field
   * belongs to, and which fields carry a blind index. Keyed by a host-chosen
   * field label (e.g. `'renter.passportNumber'`).
   */
  fields?: Record<string, CryptoFieldConfig>
  /**
   * The governance erasability gate crypto consults before a shred. Present when
   * governance is installed. When it is absent every shred is refused: crypto
   * fails closed and never decides erasability itself. See {@link ErasabilityResolver}.
   */
  erasabilityResolver?: ErasabilityResolver
}

/**
 * Augment core's open `SatelliteConfigRegistry` so `getConfig().crypto` (and any
 * `MultitenancyConfig` consumer) is typed wherever the crypto satellite is
 * imported. The augmentation lives in this package's compilation only, so core,
 * which never imports the crypto satellite, keeps a `crypto`-free public type.
 * Mirrors the AI and billing satellites.
 */
declare module '@adonisjs-lasagna/saas-tenancy/types' {
  interface SatelliteConfigRegistry {
    /** Optional crypto satellite. See {@link CryptoConfig}. */
    crypto?: CryptoConfig
  }
}

/**
 * The host's `config/multitenancy.ts` shape with the `crypto` block present.
 * Mirrors `MultitenancyConfigWithAi` so every config-bearing satellite exposes
 * the same authoring surface.
 */
export type MultitenancyConfigWithCrypto = MultitenancyConfig & { crypto?: CryptoConfig }

/**
 * Identity helper for IDE autocomplete and type-checking when authoring the
 * `crypto` block of `config/multitenancy.ts`. No runtime effect.
 */
export function defineCryptoConfig(config: CryptoConfig): CryptoConfig {
  return config
}

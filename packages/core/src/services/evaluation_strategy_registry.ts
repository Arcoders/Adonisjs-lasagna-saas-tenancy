import { DateTime } from 'luxon'
import ExtensionRegistry from './extension_registry.js'
import type { FeatureFlagRecord } from './feature_flag_service.js'

/**
 * The feature-flag evaluation-strategy contract version: the shape of
 * {@link EvaluationStrategy}. Bump as a MAJOR for a backward-incompatible change.
 * INDEPENDENT of `satelliteApi` and the published version.
 */
export const FEATURE_FLAGS_CONTRACT_VERSION = 1

/** Context handed to a strategy. The host can thread anything (e.g. `userId`)
 *  for context-aware evaluation; `tenantId` and `flag` are always present. */
export interface FeatureFlagEvaluationContext {
  tenantId: string
  flag: string
  [key: string]: unknown
}

/**
 * A host-registered decision function for a feature flag. Selected per-flag via
 * the flag's `config.strategy` name. Evaluated PER CALL against the stored
 * record plus the caller's context. A context-aware strategy (rollout %,
 * per-user) must never be cached as a boolean, or one user's decision would leak
 * to another. The record map cache stays at the data level only.
 */
export interface EvaluationStrategy {
  readonly name: string
  /** Contract version this strategy was built against (see {@link FEATURE_FLAGS_CONTRACT_VERSION}). */
  readonly contractVersion?: number
  evaluate(record: FeatureFlagRecord, context: FeatureFlagEvaluationContext): boolean
}

/**
 * The built-in strategy: enabled AND not past `expiresAt`. This is exactly the
 * legacy `isEnabled` logic, so a flag with no `config.strategy` behaves
 * identically to a build without this surface. Exported so the service's fast
 * path can use it without a registry lookup.
 */
export const DEFAULT_EVALUATION_STRATEGY: EvaluationStrategy = {
  name: 'default',
  contractVersion: FEATURE_FLAGS_CONTRACT_VERSION,
  evaluate(record) {
    if (!record.enabled) return false
    if (record.expiresAt && DateTime.fromISO(record.expiresAt) <= DateTime.now()) return false
    return true
  },
}

/**
 * Registry of host feature-flag evaluation strategies. Bound as a container
 * singleton by `MultitenancyProvider`; the host registers strategies in its
 * provider `boot()`. Map-backed (stateful): resolve via `container.make`, never
 * `new`. Pre-seeded with the reserved `default` strategy.
 */
export default class EvaluationStrategyRegistry extends ExtensionRegistry<
  string,
  EvaluationStrategy
> {
  protected readonly surfaceLabel = 'feature-flag strategy'

  constructor() {
    super()
    // Pre-seed the reserved built-in so `resolve()`/`get('default')` hit it.
    this.entries.set('default', DEFAULT_EVALUATION_STRATEGY)
  }

  protected override get surfaceContractVersion(): number {
    return FEATURE_FLAGS_CONTRACT_VERSION
  }

  register(strategy: EvaluationStrategy): this {
    if (strategy?.name === 'default') {
      throw new Error(
        'EvaluationStrategyRegistry: "default" is reserved for the built-in strategy.'
      )
    }
    const name = this.assertRegistrable(strategy)
    this.entries.set(name, strategy)
    return this
  }

  /**
   * Remove a previously registered strategy. The built-in `default` is never
   * removable. Returns true when a strategy was removed, false when the name was
   * the reserved default or was not registered. Useful for hot-reload paths and
   * for tests that need to undo a registration so it does not leak into the next.
   */
  override unregister(name: string): boolean {
    if (name === 'default') return false
    return super.unregister(name)
  }

  /** Clear all strategies, then re-seed the reserved `default` so it is never lost. */
  override clear(): this {
    super.clear()
    this.entries.set('default', DEFAULT_EVALUATION_STRATEGY)
    return this
  }

  get(name: string): EvaluationStrategy | undefined {
    return this.entries.get(name)
  }

  /** The named strategy, or the built-in default when unknown/omitted. */
  resolve(name?: string): EvaluationStrategy {
    return (name ? this.entries.get(name) : undefined) ?? DEFAULT_EVALUATION_STRATEGY
  }

  list(): readonly string[] {
    return [...this.entries.keys()]
  }
}

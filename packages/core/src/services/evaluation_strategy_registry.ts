import { DateTime } from 'luxon'
import { assertContractCompat } from '../sdk/contract_version.js'
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
 * record plus the caller's context — a context-aware strategy (rollout %,
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
export default class EvaluationStrategyRegistry {
  readonly #strategies = new Map<string, EvaluationStrategy>([
    ['default', DEFAULT_EVALUATION_STRATEGY],
  ])

  /** The strategy-contract version this surface implements. */
  get contractVersion(): number {
    return FEATURE_FLAGS_CONTRACT_VERSION
  }

  register(strategy: EvaluationStrategy): this {
    if (!strategy.name || typeof strategy.name !== 'string') {
      throw new Error('EvaluationStrategyRegistry: a strategy must have a non-empty name.')
    }
    if (strategy.name === 'default') {
      throw new Error(
        'EvaluationStrategyRegistry: "default" is reserved for the built-in strategy.'
      )
    }
    if (this.#strategies.has(strategy.name)) {
      throw new Error(
        `EvaluationStrategyRegistry: a strategy named "${strategy.name}" is already registered.`
      )
    }
    assertContractCompat(
      strategy.contractVersion,
      FEATURE_FLAGS_CONTRACT_VERSION,
      `feature-flag strategy "${strategy.name}"`
    )
    this.#strategies.set(strategy.name, strategy)
    return this
  }

  get(name: string): EvaluationStrategy | undefined {
    return this.#strategies.get(name)
  }

  /** The named strategy, or the built-in default when unknown/omitted. */
  resolve(name?: string): EvaluationStrategy {
    return (name ? this.#strategies.get(name) : undefined) ?? DEFAULT_EVALUATION_STRATEGY
  }

  has(name: string): boolean {
    return this.#strategies.has(name)
  }

  list(): readonly string[] {
    return [...this.#strategies.keys()]
  }
}

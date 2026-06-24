import type { MultitenancyConfig } from '@adonisjs-lasagna/saas-tenancy/types'
import {
  isSafeMetricName,
  isCustomAggregation,
  type CustomAggregation,
} from './custom_aggregate.js'

/**
 * Optional, declarative metadata for a host-defined custom metric. Aggregation
 * still works for *unregistered* names (dynamic `SUM`); this block only supplies
 * a default aggregation + a human description for display.
 */
export interface ReportingMetricDefinition {
  /** Safe identifier matching the name passed to `metrics.emitMetric()`. */
  name: string
  description?: string
  aggregation?: CustomAggregation
}

export interface ReportingConfig {
  metrics?: ReportingMetricDefinition[]
  /**
   * Opt-in monthly rollup read path. When `enabled`, whole-month, fully-closed,
   * covered windows are served from `tenant_metrics_monthly` (populated by
   * `tenant:metrics:rollup`) instead of the daily base. Off by default.
   */
  rollups?: { enabled?: boolean }
  /**
   * Dashboard cache behavior. `invalidateOnFlush` (off by default) clears the
   * global `reporting` cache namespace when a `MetricsFlushed` event fires, so a
   * cached dashboard refreshes the moment `tenant:metrics:flush` lands. Pair it
   * with a `cacheTtlMs > 0` on the routes (otherwise there's nothing to clear).
   */
  cache?: { invalidateOnFlush?: boolean }
}

/** The core config extended with the optional `reporting` block (decoupled from
 *  core's `MultitenancyConfig`, like the websockets satellite). */
export type MultitenancyConfigWithReporting = MultitenancyConfig & { reporting?: ReportingConfig }

/** Identity helper for typed authoring in `config/multitenancy.ts`. */
export function defineReportingConfig(config: ReportingConfig): ReportingConfig {
  return config
}

/**
 * Eager, pure validation of the `reporting` config block so a bad shape fails at
 * boot (in `ReportingProvider.boot`) rather than at the first query. `undefined`
 * passes (the block is optional); only a present-but-wrong shape throws. Kept off
 * the public barrel — an internal seam imported by the provider.
 */
export function assertReportingConfig(config: ReportingConfig | undefined): void {
  if (config === undefined || config === null) return
  if (typeof config !== 'object') {
    throw new Error('[reporting] config.reporting must be an object')
  }
  assertRollupsConfig(config.rollups)
  assertCacheConfig(config.cache)
  if (config.metrics === undefined) return
  if (!Array.isArray(config.metrics)) {
    throw new Error('[reporting] config.reporting.metrics must be an array')
  }

  const seen = new Set<string>()
  for (const def of config.metrics) {
    if (!def || typeof def !== 'object') {
      throw new Error('[reporting] each config.reporting.metrics entry must be an object')
    }
    if (!isSafeMetricName(def.name)) {
      throw new Error(
        `[reporting] metric name ${JSON.stringify(def.name)} is invalid — must match /^[a-zA-Z0-9_-]{1,63}$/`
      )
    }
    if (seen.has(def.name)) {
      throw new Error(`[reporting] duplicate metric name "${def.name}" in config.reporting.metrics`)
    }
    seen.add(def.name)
    if (def.aggregation !== undefined && !isCustomAggregation(def.aggregation)) {
      throw new Error(
        `[reporting] metric "${def.name}" has invalid aggregation "${def.aggregation}" — ` +
          `expected one of sum, avg, count, max, min`
      )
    }
    if (def.description !== undefined && typeof def.description !== 'string') {
      throw new Error(`[reporting] metric "${def.name}" description must be a string`)
    }
  }
}

/** Validate the optional `rollups` block. Pure; called by {@link assertReportingConfig}. */
export function assertRollupsConfig(rollups: ReportingConfig['rollups']): void {
  if (rollups === undefined || rollups === null) return
  if (typeof rollups !== 'object') {
    throw new Error('[reporting] config.reporting.rollups must be an object')
  }
  if (rollups.enabled !== undefined && typeof rollups.enabled !== 'boolean') {
    throw new Error('[reporting] config.reporting.rollups.enabled must be a boolean')
  }
}

/** Validate the optional `cache` block. Pure; called by {@link assertReportingConfig}. */
export function assertCacheConfig(cache: ReportingConfig['cache']): void {
  if (cache === undefined || cache === null) return
  if (typeof cache !== 'object') {
    throw new Error('[reporting] config.reporting.cache must be an object')
  }
  if (cache.invalidateOnFlush !== undefined && typeof cache.invalidateOnFlush !== 'boolean') {
    throw new Error('[reporting] config.reporting.cache.invalidateOnFlush must be a boolean')
  }
}

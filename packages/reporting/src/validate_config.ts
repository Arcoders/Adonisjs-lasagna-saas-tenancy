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

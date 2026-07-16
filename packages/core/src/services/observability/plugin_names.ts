/**
 * Single-source catalog of the per-tenant metric names the plugin platform emits.
 * A metric name is a stable operator-facing contract
 * (dashboards, alerts key off it), so it lives here as a frozen `as const` rather
 * than a scattered string literal, and `behavior_plugin_names.spec.ts` pins the
 * exact values so a rename is a conscious, reviewed change.
 *
 * These route through `MetricsService.emitMetric(tenantId, name, value)` (the
 * per-tenant Redis-to-backoffice sink) because they attribute a RUNTIME fault to the
 * tenant it happened under. Global/config faults (collisions, contract mismatch)
 * go to Isthmus counters instead, never a synthetic tenant id.
 */
export const PLUGIN_METRIC = {
  /** A `definePlugin({ onDataChange })` subscriber threw handling a change. */
  dataChangeSubscriberErrors: 'data_change_subscriber_errors',
} as const

export type PluginMetricName = (typeof PLUGIN_METRIC)[keyof typeof PLUGIN_METRIC]

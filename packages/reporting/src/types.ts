export type ReportPeriod = 'day' | 'week' | 'month'

export interface AggregationOptions {
  /** Bucket granularity. Default `'day'`. */
  period?: ReportPeriod
  /** Inclusive ISO date (`YYYY-MM-DD`) lower bound. Default: 30 days ago. */
  since?: string
  /** Inclusive ISO date (`YYYY-MM-DD`) upper bound. Default: today. */
  until?: string
  /** Top-N cap for `getTopTenants`. Default 50, hard-capped at 1000. */
  limit?: number
}

export interface ReportAggregate {
  /** The bucket label (`YYYY-MM-DD` start-of-period). */
  period: string
  totalRequests: number
  totalErrors: number
  totalBandwidthBytes: number
  activeTenants: number
  /** errors / requests, clamped to [0, 1]; 0 when there were no requests. */
  errorRate: number
}

export interface TopTenantMetric {
  tenantId: string
  requests: number
  errors: number
  bandwidthBytes: number
  errorRate: number
}

export interface TenantUsage {
  requests: number
  errors: number
  bandwidthBytes: number
}

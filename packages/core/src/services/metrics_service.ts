import redis from '@adonisjs/redis/services/main'
import TenantMetric from '../models/satellites/tenant_metric.js'
import { DateTime } from 'luxon'

export default class MetricsService {
  private key(tenantId: string, metric: string, period: string) {
    return `metrics:${tenantId}:${period}:${metric}`
  }

  private currentPeriod(): string {
    return DateTime.utc().toFormat('yyyy-MM-dd')
  }

  async increment(tenantId: string, metric: 'requests' | 'errors', amount = 1): Promise<void> {
    const period = this.currentPeriod()
    await redis.incrby(this.key(tenantId, metric, period), amount)
    await redis.expire(this.key(tenantId, metric, period), 172800)
  }

  async trackBandwidth(tenantId: string, bytes: number): Promise<void> {
    const period = this.currentPeriod()
    await redis.incrby(this.key(tenantId, 'bandwidth', period), bytes)
    await redis.expire(this.key(tenantId, 'bandwidth', period), 172800)
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    const keys: string[] = []
    let cursor = '0'
    do {
      const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200)
      keys.push(...(batch as string[]))
      cursor = next as string
    } while (cursor !== '0')
    return keys
  }

  async flush(period?: string): Promise<void> {
    const target = period ?? this.currentPeriod()
    const pattern = `metrics:*:${target}:*`
    const keys = await this.scanKeys(pattern)

    const tenantPeriods = new Map<string, { requests: number; errors: number; bandwidth: number }>()

    for (const key of keys) {
      const parts = key.split(':')
      const tenantId = parts[1]
      const metric = parts[3]
      const value = Number(await redis.get(key)) || 0

      if (!tenantPeriods.has(tenantId)) {
        tenantPeriods.set(tenantId, { requests: 0, errors: 0, bandwidth: 0 })
      }

      const entry = tenantPeriods.get(tenantId)!
      if (metric === 'requests') entry.requests = value
      if (metric === 'errors') entry.errors = value
      if (metric === 'bandwidth') entry.bandwidth = value
    }

    for (const [tenantId, counts] of tenantPeriods) {
      await TenantMetric.updateOrCreate(
        { tenantId, period: target },
        {
          requestCount: counts.requests,
          errorCount: counts.errors,
          bandwidthBytes: counts.bandwidth,
        }
      )
    }
  }

  async getForTenant(tenantId: string, days = 30): Promise<TenantMetric[]> {
    const since = DateTime.utc().minus({ days }).toFormat('yyyy-MM-dd')
    return TenantMetric.query()
      .where('tenant_id', tenantId)
      .where('period', '>=', since)
      .orderBy('period', 'desc')
  }
}

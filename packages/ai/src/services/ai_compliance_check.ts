import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../define_config.js'
import type { AiRedisProbe } from './redis_seam.js'

export interface AiComplianceCheckDeps {
  getAiConfig: () => AiConfig | undefined
  /** Raw Redis accessor (the `'redis'` binding), for a read-only reachability + keyPrefix probe. */
  getRedis: () => Promise<AiRedisProbe>
}

/**
 * The `ai_compliance` doctor check: the purge posture an operator must
 * see before relying on right-to-erasure. It is strictly READ-ONLY: it PINGs
 * Redis and reads `options.keyPrefix`, but NEVER bumps the epoch (that would
 * invalidate live replay caches as a side effect of a health check). It warns
 * when Redis is unreachable (memory purge + the cache-epoch bump cannot run) and
 * confirms, as info, that a configured keyPrefix is honored by the prefix-aware
 * SCAN (so a prefixed deployment is not a silent no-op).
 */
export function aiComplianceCheck(deps: AiComplianceCheckDeps): DoctorCheck {
  return {
    name: 'ai_compliance',
    description:
      'Reports the purge posture: Redis reachability for memory / response-cache erasure, and any ' +
      'keyPrefix the prefix-aware SCAN must honor so a prefixed deployment does not silently erase nothing.',
    async run(): Promise<DiagnosisIssue[]> {
      if (!deps.getAiConfig()) return []
      let redis: AiRedisProbe
      try {
        redis = await deps.getRedis()
        await redis.ping()
      } catch {
        return [
          {
            code: 'ai_compliance_redis_unreachable',
            severity: 'warn',
            message:
              'Redis is unreachable: conversation-memory purge and the response-cache epoch bump ' +
              '(tenant:ai:purge, and the auto-purge on tenant destroy / anonymize) cannot run until it recovers.',
          },
        ]
      }
      const keyPrefix = redis?.options?.keyPrefix
      if (typeof keyPrefix === 'string' && keyPrefix.length > 0) {
        return [
          {
            code: 'ai_compliance_redis_key_prefix',
            severity: 'info',
            message:
              `Redis keyPrefix "${keyPrefix}" is set: the memory purge prepends it to its SCAN ` +
              'MATCH so a right-to-erasure is not a silent no-op. No action needed; this confirms the path is active.',
          },
        ]
      }
      return []
    },
  }
}

import CircuitBreakerService from '../../services/circuit_breaker_service.js'
import ResilienceService from '../../services/resilience_service.js'
import ReadReplicaService from '../../services/read_replica_service.js'
import QuotaService from '../../services/quota_service.js'
import type { InstallerContext, ProviderInstaller } from './installer.js'

/**
 * Runtime-protection service plane: the per-tenant circuit breaker, the retry/
 * timeout resilience helper, the read-replica LRU, and the quota enforcer. All are
 * register-only: each borrows a shared handle (the breaker's opossum timers are
 * unref()-ed, Quota/Replica ride the shared @adonisjs/redis connection), so none
 * owns a libuv handle to drain at shutdown.
 */
export const resilienceWiring: ProviderInstaller = {
  name: 'resilience',

  register(ctx: InstallerContext): void {
    ctx.app.container.singleton(CircuitBreakerService, () => new CircuitBreakerService())
    ctx.app.container.singleton(ResilienceService, () => new ResilienceService())
    ctx.app.container.singleton(ReadReplicaService, () => new ReadReplicaService())
    ctx.app.container.singleton(QuotaService, () => new QuotaService())
  },
}

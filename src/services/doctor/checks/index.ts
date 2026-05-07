export { default as schemaDriftCheck } from './schema_drift_check.js'
export { default as migrationStateCheck } from './migration_state_check.js'
export { default as circuitBreakerCheck } from './circuit_breaker_check.js'
export { default as queueStuckCheck } from './queue_stuck_check.js'
export { default as backupRecencyCheck } from './backup_recency_check.js'
export { default as provisioningStalledCheck } from './provisioning_stalled_check.js'
export { default as failedTenantsCheck } from './failed_tenants_check.js'
export { default as replicaLagCheck } from './replica_lag_check.js'
export { default as connectionPoolCheck } from './connection_pool_check.js'
export { default as longRunningQueriesCheck } from './long_running_queries_check.js'

import schemaDriftCheck from './schema_drift_check.js'
import migrationStateCheck from './migration_state_check.js'
import circuitBreakerCheck from './circuit_breaker_check.js'
import queueStuckCheck from './queue_stuck_check.js'
import backupRecencyCheck from './backup_recency_check.js'
import provisioningStalledCheck from './provisioning_stalled_check.js'
import failedTenantsCheck from './failed_tenants_check.js'
import replicaLagCheck from './replica_lag_check.js'
import connectionPoolCheck from './connection_pool_check.js'
import longRunningQueriesCheck from './long_running_queries_check.js'
import type { DoctorCheck } from '../types.js'

export const builtInChecks: DoctorCheck[] = [
  failedTenantsCheck,
  provisioningStalledCheck,
  schemaDriftCheck,
  migrationStateCheck,
  circuitBreakerCheck,
  queueStuckCheck,
  backupRecencyCheck,
  replicaLagCheck,
  connectionPoolCheck,
  longRunningQueriesCheck,
]

export { default as schemaDriftCheck } from './schema_drift_check.js'
export { default as migrationStateCheck } from './migration_state_check.js'
export { default as migrationDriftCheck } from './migration_drift_check.js'
export { default as tenantLifecycleCheck } from './tenant_lifecycle_check.js'
export { default as circuitBreakerCheck } from './circuit_breaker_check.js'
export { default as queueStuckCheck } from './queue_stuck_check.js'
// `backupRecencyCheck` moved to `@adonisjs-lasagna/backup`; its provider
// registers the check into `DoctorService` on boot.
export { default as provisioningStalledCheck } from './provisioning_stalled_check.js'
export { default as failedTenantsCheck } from './failed_tenants_check.js'
export { default as replicaLagCheck } from './replica_lag_check.js'
export { default as connectionPoolCheck } from './connection_pool_check.js'
export { default as longRunningQueriesCheck } from './long_running_queries_check.js'
export { default as membershipGateCheck } from './membership_gate_check.js'
export { default as pgBouncerCheck } from './pgbouncer_check.js'
// Opt-in: NOT added to `builtInChecks` (a fresh/empty metrics table would always
// warn). Hosts running the metrics pipeline register it explicitly.
export { default as metricsFreshnessCheck } from './metrics_freshness_check.js'
// Opt-in: NOT added to `builtInChecks` (a host without the pgvector satellite has
// no vector extension and would always error). Hosts using pgvector register it.
export { default as pgvectorExtensionCheck } from './pgvector_extension_check.js'

import schemaDriftCheck from './schema_drift_check.js'
import migrationStateCheck from './migration_state_check.js'
import migrationDriftCheck from './migration_drift_check.js'
import tenantLifecycleCheck from './tenant_lifecycle_check.js'
import circuitBreakerCheck from './circuit_breaker_check.js'
import queueStuckCheck from './queue_stuck_check.js'
import provisioningStalledCheck from './provisioning_stalled_check.js'
import failedTenantsCheck from './failed_tenants_check.js'
import replicaLagCheck from './replica_lag_check.js'
import connectionPoolCheck from './connection_pool_check.js'
import longRunningQueriesCheck from './long_running_queries_check.js'
import membershipGateCheck from './membership_gate_check.js'
import pgBouncerCheck from './pgbouncer_check.js'
import type { DoctorCheck } from '../types.js'

/**
 * The ordered list of default diagnostic checks the multitenancy provider registers into
 * `DoctorService` at boot, covering failed and stalled tenant provisioning, the
 * status/deletedAt lifecycle, schema drift, migration state and migration drift (behind
 * head), the circuit breaker, stuck queues, replica lag, connection pool usage,
 * long-running queries, and the membership gate. The opt-in `metricsFreshnessCheck` is
 * deliberately excluded because an empty metrics table would always warn, so hosts running
 * the metrics pipeline register that one explicitly.
 *
 * @see DoctorCheck
 */
export const builtInChecks: DoctorCheck[] = [
  failedTenantsCheck,
  provisioningStalledCheck,
  tenantLifecycleCheck,
  schemaDriftCheck,
  migrationStateCheck,
  migrationDriftCheck,
  circuitBreakerCheck,
  queueStuckCheck,
  replicaLagCheck,
  connectionPoolCheck,
  longRunningQueriesCheck,
  membershipGateCheck,
  pgBouncerCheck,
]

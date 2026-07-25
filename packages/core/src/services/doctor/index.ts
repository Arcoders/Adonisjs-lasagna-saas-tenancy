export { default as DoctorService } from './doctor_service.js'
export type {
  DiagnosisSeverity,
  DiagnosisScope,
  DiagnosisIssue,
  DiagnosisReport,
  DoctorCheck,
  DoctorContext,
  DoctorRunOptions,
  DoctorRunResult,
  DoctorRunStatus,
} from './types.js'
export {
  builtInChecks,
  schemaDriftCheck,
  migrationStateCheck,
  migrationDriftCheck,
  tenantLifecycleCheck,
  circuitBreakerCheck,
  queueStuckCheck,
  provisioningStalledCheck,
  failedTenantsCheck,
  replicaLagCheck,
  connectionPoolCheck,
  longRunningQueriesCheck,
  membershipGateCheck,
  metricsFreshnessCheck,
  pgvectorExtensionCheck,
} from './checks/index.js'

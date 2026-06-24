export { default as DoctorService } from './doctor_service.js'
export type {
  DiagnosisSeverity,
  DiagnosisIssue,
  DiagnosisReport,
  DoctorCheck,
  DoctorContext,
  DoctorRunOptions,
  DoctorRunResult,
} from './types.js'
export {
  builtInChecks,
  schemaDriftCheck,
  migrationStateCheck,
  circuitBreakerCheck,
  queueStuckCheck,
  provisioningStalledCheck,
  failedTenantsCheck,
  replicaLagCheck,
  connectionPoolCheck,
  longRunningQueriesCheck,
  metricsFreshnessCheck,
} from './checks/index.js'

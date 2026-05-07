import type { TenantModelContract, TenantRepositoryContract } from '../../types/contracts.js'

export type DiagnosisSeverity = 'info' | 'warn' | 'error'

export interface DiagnosisIssue {
  /** Stable code for programmatic handling, e.g. `schema_missing`. */
  code: string
  severity: DiagnosisSeverity
  /** Human-readable message. */
  message: string
  /** Tenant the issue is about, if applicable. */
  tenantId?: string
  /** True when the parent check declares it can auto-fix this issue. */
  fixable?: boolean
  /** Extra structured detail (rendered in --json mode). */
  meta?: Record<string, unknown>
}

export interface DoctorContext {
  /** Tenants in scope for this run (filtered by --tenant if provided). */
  tenants: TenantModelContract[]
  repo: TenantRepositoryContract
  /** Whether the user requested --fix; checks decide what to do per issue. */
  attemptFix: boolean
}

export interface DoctorCheck {
  /** Stable name; user-targetable via `--check=<name>`. */
  readonly name: string
  /** Short description shown in `--help` style listings. */
  readonly description: string
  run(ctx: DoctorContext): Promise<DiagnosisIssue[]> | DiagnosisIssue[]
}

export interface DiagnosisReport {
  check: string
  description: string
  durationMs: number
  issues: DiagnosisIssue[]
  error?: string
}

export interface DoctorRunOptions {
  tenants?: string[]
  checks?: string[]
  fix?: boolean
}

export interface DoctorRunResult {
  reports: DiagnosisReport[]
  totals: {
    info: number
    warn: number
    error: number
    fixable: number
  }
}

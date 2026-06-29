import type { TenantModelContract, TenantRepositoryContract } from '../../types/contracts.js'

/**
 * String-literal union classifying the seriousness of a doctor diagnosis issue, with three
 * ascending levels: informational notices, non-blocking warnings, and hard errors. It types
 * the `severity` field on each `DiagnosisIssue` and drives the per-level counters tallied in
 * a `DoctorRunResult` totals object.
 */
export type DiagnosisSeverity = 'info' | 'warn' | 'error'

/**
 * Describes a single problem surfaced by a doctor check during a diagnostic run.
 * Carries a stable machine-readable `code` for programmatic handling, a
 * `severity` of info, warn, or error, and a human-readable `message`. It
 * optionally records the `tenantId` the issue concerns, a `fixable` flag set
 * when the parent check can auto-repair it, and a `meta` map of extra
 * structured detail rendered in JSON output mode.
 */
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

/**
 * Shared run context handed to every doctor check's `run()` method during a diagnostic
 * pass. It carries the tenants in scope for the run (filtered by `--tenant` when provided),
 * the bound tenant repository the check can query, and the `attemptFix` flag that signals
 * whether the user requested `--fix` so each check can decide how to handle its issues.
 */
export interface DoctorContext {
  /** Tenants in scope for this run (filtered by --tenant if provided). */
  tenants: TenantModelContract[]
  repo: TenantRepositoryContract
  /** Whether the user requested --fix; checks decide what to do per issue. */
  attemptFix: boolean
}

/**
 * Contract for a single pluggable doctor diagnostic. Each check carries a stable
 * name that users can target via `--check=<name>`, a short description for help
 * listings, and a `run` method that receives a DoctorContext and returns the
 * diagnosis issues it found, either synchronously or as a promise.
 */
export interface DoctorCheck {
  /** Stable name; user-targetable via `--check=<name>`. */
  readonly name: string
  /** Short description shown in `--help` style listings. */
  readonly description: string
  run(ctx: DoctorContext): Promise<DiagnosisIssue[]> | DiagnosisIssue[]
}

/**
 * Captures the result of running a single doctor check during a diagnosis pass.
 * It records the check's stable name and description, the wall-clock duration in
 * milliseconds, the list of issues the check produced, and an optional error string
 * set when the check itself threw rather than completing normally. A run aggregates
 * one of these per check into a DoctorRunResult.
 */
export interface DiagnosisReport {
  check: string
  description: string
  durationMs: number
  issues: DiagnosisIssue[]
  error?: string
}

/**
 * Options bag passed to the doctor service's `run` method that narrows and configures a diagnostic pass.
 * The optional `tenants` field restricts the run to the listed tenant ids, `checks` limits execution to the
 * named diagnostic checks, and `fix` toggles auto-fix mode so checks attempt to repair the issues they find.
 * All fields are optional, and omitting them runs every registered check across every tenant in report-only mode.
 */
export interface DoctorRunOptions {
  tenants?: string[]
  checks?: string[]
  fix?: boolean
}

/**
 * Aggregated outcome returned by the doctor service after a diagnostic run completes. It holds
 * the per-check `DiagnosisReport` entries collected during the run alongside a `totals` tally that
 * counts how many issues were classified as info, warn, error, and how many are flagged fixable,
 * giving callers and the CLI a single object to render or inspect.
 */
export interface DoctorRunResult {
  reports: DiagnosisReport[]
  totals: {
    info: number
    warn: number
    error: number
    fixable: number
  }
}

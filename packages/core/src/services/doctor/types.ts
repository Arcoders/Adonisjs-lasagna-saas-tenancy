import type { TenantModelContract, TenantRepositoryContract } from '../../types/contracts.js'

/**
 * String-literal union classifying the seriousness of a doctor diagnosis issue, with three
 * ascending levels: informational notices, non-blocking warnings, and hard errors. It types
 * the `severity` field on each `DiagnosisIssue` and drives the per-level counters tallied in
 * a `DoctorRunResult` totals object.
 */
export type DiagnosisSeverity = 'info' | 'warn' | 'error'

/**
 * Whether an issue is confined to a single tenant or affects the whole platform.
 * This is what separates "one tenant needs attention" (the report stays reachable,
 * HTTP 200) from "the infrastructure is down" (HTTP 503): a `tenant`-scoped error
 * degrades, a `platform`-scoped error fails. When a check omits it, the doctor
 * infers `tenant` from a present `tenantId` and `platform` otherwise.
 */
export type DiagnosisScope = 'platform' | 'tenant'

/**
 * Describes a single problem surfaced by a doctor check during a diagnostic run.
 * Carries a stable machine-readable `code` for programmatic handling, a
 * `severity` of info, warn, or error, and a human-readable `message`. It
 * optionally records the `tenantId` the issue concerns, a `scope` (platform vs
 * tenant, driving the degraded-vs-down verdict), a `fixable` flag set when the
 * parent check can auto-repair it, and a `meta` map of extra structured detail
 * rendered in JSON output mode.
 */
export interface DiagnosisIssue {
  /** Stable code for programmatic handling, e.g. `schema_missing`. */
  code: string
  severity: DiagnosisSeverity
  /** Human-readable message. */
  message: string
  /** Tenant the issue is about, if applicable. */
  tenantId?: string | undefined
  /**
   * Whether this issue is tenant-confined or platform-wide. Drives the run's
   * tri-state verdict (a platform error fails the report; a tenant error only
   * degrades it). Optional: when omitted the doctor infers `tenant` if `tenantId`
   * is set, else `platform`.
   */
  scope?: DiagnosisScope | undefined
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
  tenants?: string[] | undefined
  checks?: string[] | undefined
  fix?: boolean
}

/**
 * The tri-state verdict of a whole doctor run, mirroring `/readyz`: `ok` (nothing
 * to act on), `degraded` (one or more tenant-scoped errors, but the platform is
 * healthy), or `fail` (at least one platform-scoped error). It is what lets
 * `/admin/health/report` answer 200-degraded for a lone tenant's problem and
 * reserve 503 for genuine infrastructure failure.
 */
export type DoctorRunStatus = 'ok' | 'degraded' | 'fail'

/**
 * Aggregated outcome returned by the doctor service after a diagnostic run completes. It holds
 * the per-check `DiagnosisReport` entries collected during the run alongside a `totals` tally that
 * counts how many issues were classified as info, warn, error, and how many are flagged fixable,
 * plus a scope split of the errors (`platformError`/`tenantError`) and the derived tri-state
 * `status`, giving callers and the CLI a single object to render or inspect.
 */
export interface DoctorRunResult {
  reports: DiagnosisReport[]
  /**
   * The run's tri-state verdict: `fail` if any platform-scoped error, else
   * `degraded` if any tenant-scoped error, else `ok`.
   */
  status: DoctorRunStatus
  totals: {
    info: number
    warn: number
    error: number
    fixable: number
    /** Error-severity issues scoped to the platform (drive `fail`). */
    platformError: number
    /** Error-severity issues scoped to a single tenant (drive `degraded`). */
    tenantError: number
  }
}

import type { Database } from '@adonisjs/lucid/database'
import type { MultitenancyConfig } from '../../types/config.js'

/**
 * String literal union describing the outcome a compliance control reports after
 * inspecting runtime posture. A control is `satisfied` when the system already
 * meets the expectation, `action-needed` when a concrete remediation step remains
 * for the host, or `info` for advisory results that carry no pass or fail judgement.
 */
export type ControlStatus = 'satisfied' | 'action-needed' | 'info'

/**
 * Everything a control needs to introspect posture: the resolved runtime config
 * and a Lucid `Database` handle. Passing these in (rather than reaching into the
 * container) keeps each `detect()` unit-testable against doubles.
 */
export interface ComplianceContext {
  config: MultitenancyConfig
  db: Database
}

/**
 * Result shape returned by a compliance control's `detect()` method, describing
 * the posture it found at runtime. It carries the assessed `status`, an
 * auditable `evidence` string of what the system actually shows, the
 * `hostResponsibility` that remains the host application's job even when
 * satisfied, and an optional `remediation` next step for an `action-needed`
 * status. The registry later enriches this with the control's id, title, and
 * frameworks to form a full result.
 */
export interface ControlDetection {
  status: ControlStatus
  /** What the system actually shows right now (the auditable fact). */
  evidence: string
  /** What stays the host's job even when this control is satisfied. */
  hostResponsibility: string
  /** Optional concrete next step when the status is `action-needed`. */
  remediation?: string
}

/**
 * One posture control. `frameworks` are namespaced tokens (`<framework>:<ref>`,
 * e.g. `gdpr:art30`, `soc2:CC7.2`) so a single control can map to several
 * frameworks at once and `--framework=<x>` can filter without duplicating logic.
 * Mirrors `DoctorCheck` so the registry, command, and tests feel identical.
 */
export interface ComplianceControl {
  readonly id: string
  readonly title: string
  readonly frameworks: string[]
  detect(ctx: ComplianceContext): Promise<ControlDetection> | ControlDetection
}

/**
 * A fully evaluated compliance control as it appears in a report, extending the raw
 * `ControlDetection` output (status, evidence, host responsibility, optional remediation)
 * with the control's identity metadata so each result carries its own id, human-readable
 * title, and the namespaced framework tokens it maps to. The registry produces one of these
 * per control by merging a control's `detect()` result with its declared id, title, and
 * frameworks, and a `ComplianceReport` holds these in its `controls` array.
 */
export interface ControlResult extends ControlDetection {
  id: string
  title: string
  frameworks: string[]
}

/**
 * Aggregated outcome of a compliance run. It collects the per-control results into
 * a `controls` array of `ControlResult` entries and a `totals` tally that counts how
 * many controls came back satisfied, action-needed, or informational, giving callers a
 * single object to render or assert against.
 */
export interface ComplianceReport {
  controls: ControlResult[]
  totals: { satisfied: number; actionNeeded: number; info: number }
}

/**
 * Optional filter arguments passed to `ComplianceReportService.run()` that narrow
 * which posture controls execute. The `framework` field selects controls by the
 * token prefix (`soc2`, `gdpr`, `iso`, `hipaa`, or the default `all`), while
 * `controls` restricts the run to specific control ids; when both are omitted
 * every registered control runs.
 */
export interface ComplianceRunOptions {
  /** `soc2` | `gdpr` | `iso` | `hipaa` | `all` (default). Matches the token prefix. */
  framework?: string
  /** Run only the named control id(s). */
  controls?: string[]
}

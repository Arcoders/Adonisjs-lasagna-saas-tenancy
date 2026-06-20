import type { Database } from '@adonisjs/lucid/database'
import type { MultitenancyConfig } from '../../types/config.js'

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

/** What a control's `detect()` returns; the registry adds id/title/frameworks. */
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

export interface ControlResult extends ControlDetection {
  id: string
  title: string
  frameworks: string[]
}

export interface ComplianceReport {
  controls: ControlResult[]
  totals: { satisfied: number; actionNeeded: number; info: number }
}

export interface ComplianceRunOptions {
  /** `soc2` | `gdpr` | `iso` | `hipaa` | `all` (default). Matches the token prefix. */
  framework?: string
  /** Run only the named control id(s). */
  controls?: string[]
}

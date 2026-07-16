/**
 * The Tier-1 gate (RFC section 5). Only deterministic, fail-closed checks can block.
 * Each check has a severity (gate | warn | off) so a check is adopted as a
 * warning first and promoted to a gate later. A finding blocks only when its
 * severity is `gate` AND its key is not in the baseline (new drift).
 *
 * Default severities are deliberately conservative: dead-member is `warn` out of
 * the box, so the gate never blocks on day 1. Coverage floors default to 0.
 */
import type { DocCoverageConfig } from './config.js'
import type { DoctorResult } from './doctor.js'
import type { Baseline } from './baseline.js'

export type Severity = 'gate' | 'warn' | 'off'

export interface SeverityConfig {
  /** D2-hard: prose calling `Symbol.member()` that no longer exists. */
  deadMember: Severity
  /** Coverage `explained%` below the configured floor. */
  coverageFloor: Severity
}

export const DEFAULT_SEVERITY: SeverityConfig = {
  deadMember: 'warn',
  coverageFloor: 'gate',
}

export interface GateFinding {
  key: string
  check: string
  message: string
  severity: Severity
}

export interface GateOutcome {
  /** Severity `gate`, not in baseline. These set a non-zero exit code. */
  blocking: GateFinding[]
  /** Severity `warn`, or `gate` findings already in the baseline. */
  warnings: GateFinding[]
  coverageFloorOk: boolean
  /** All current finding keys (for `--update-baseline`). */
  allKeys: string[]
}

export function runGate(
  result: DoctorResult,
  config: DocCoverageConfig,
  severity: SeverityConfig = DEFAULT_SEVERITY,
  baseline: Baseline | null = null
): GateOutcome {
  const accepted = new Set(baseline?.findings ?? [])
  const candidate: GateFinding[] = []

  // D2-hard: dead member named in prose.
  for (const f of result.d2hard) {
    candidate.push({
      key: `dead-member|${f.symbol}|${f.member}`,
      check: 'dead-member',
      severity: severity.deadMember,
      message: `${f.doc}:${f.line} prose calls ${f.symbol.split('#')[1]}.${f.member}() which is not a member`,
    })
  }

  // Coverage floor.
  const floor = config.coverageFloors.explained
  const coverageFloorOk = result.coverage.pct.explained >= floor
  if (!coverageFloorOk) {
    candidate.push({
      key: 'coverage-floor|explained',
      check: 'coverage-floor',
      severity: severity.coverageFloor,
      message: `explained coverage ${result.coverage.pct.explained}% is below the floor ${floor}%`,
    })
  }

  const blocking: GateFinding[] = []
  const warnings: GateFinding[] = []
  for (const f of candidate) {
    if (f.severity === 'off') continue
    if (f.severity === 'gate' && !accepted.has(f.key)) blocking.push(f)
    else warnings.push(f)
  }

  return {
    blocking,
    warnings,
    coverageFloorOk,
    allKeys: candidate.filter((f) => f.severity !== 'off').map((f) => f.key),
  }
}

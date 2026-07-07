/**
 * Pure supply-chain audit helpers for the `lasagna:health-check` command (S2).
 * The command shells `npm audit --json` and reads each installed satellite's
 * package.json; these functions turn that raw data into a report. Kept pure (no
 * fs, no child_process) so they are unit-tested directly — the command wrapper is
 * a thin shell around them.
 */

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical'

const SEVERITY_ORDER: readonly Severity[] = ['info', 'low', 'moderate', 'high', 'critical']

export interface AuditAdvisory {
  name: string
  severity: string
  title: string
}

export interface AuditReport {
  total: number
  bySeverity: Record<Severity, number>
  advisories: AuditAdvisory[]
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
}

/**
 * Parse `npm audit --json` (npm v7+ shape) into a report. Reads the summary from
 * `metadata.vulnerabilities` and the per-package severity/title from the
 * `vulnerabilities` map. Tolerant of a missing or partial object (returns zeros).
 */
export function parseNpmAudit(raw: unknown): AuditReport {
  const obj = asRecord(raw)
  const meta = asRecord(asRecord(obj.metadata).vulnerabilities)
  const bySeverity: Record<Severity, number> = {
    info: num(meta.info),
    low: num(meta.low),
    moderate: num(meta.moderate),
    high: num(meta.high),
    critical: num(meta.critical),
  }
  const summed = SEVERITY_ORDER.reduce((sum, sev) => sum + bySeverity[sev], 0)
  const total = num(meta.total) || summed

  const advisories: AuditAdvisory[] = []
  const vulns = obj.vulnerabilities
  if (vulns && typeof vulns === 'object') {
    for (const [name, entry] of Object.entries(vulns as Record<string, unknown>)) {
      const v = asRecord(entry)
      const severity = typeof v.severity === 'string' ? v.severity : 'unknown'
      const via = Array.isArray(v.via)
        ? v.via.find(
            (x) =>
              x && typeof x === 'object' && typeof (x as Record<string, unknown>).title === 'string'
          )
        : undefined
      const title = via ? String((via as Record<string, unknown>).title) : ''
      advisories.push({ name, severity, title })
    }
  }
  return { total, bySeverity, advisories }
}

/**
 * Count vulnerabilities at or above a severity threshold — the number a caller
 * uses to decide the command's exit code (a supply-chain gate should fail on a
 * `high`/`critical`, not on informational advisories).
 */
export function countAtOrAbove(report: AuditReport, threshold: Severity): number {
  const min = SEVERITY_ORDER.indexOf(threshold)
  return SEVERITY_ORDER.slice(min).reduce((sum, sev) => sum + report.bySeverity[sev], 0)
}

/**
 * True when a package.json declares an install lifecycle script
 * (`preinstall` / `install` / `postinstall`) — the vector `--ignore-scripts`
 * blocks. A satellite with one is flagged so the operator installs it with
 * `--ignore-scripts` and reviews the script.
 */
export function hasInstallScripts(scripts: unknown): boolean {
  const s = asRecord(scripts)
  return ['preinstall', 'install', 'postinstall'].some(
    (key) => typeof s[key] === 'string' && (s[key] as string).length > 0
  )
}

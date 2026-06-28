/**
 * Baseline + ratchet (RFC adoption section). The baseline records the *currently
 * accepted* set of finding keys plus the coverage floors. CI fails only on
 * findings NOT in the baseline (new drift), exactly like the repo's coverage
 * floors, so day 1 is never red and existing debt is burned down by ratcheting.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'

export interface Baseline {
  version: number
  /** Accepted finding keys (see gate.ts `key`). */
  findings: string[]
  floors: { explained: number; exemplified: number }
}

export const BASELINE_VERSION = 1

export function loadBaseline(path: string): Baseline | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Baseline
    if (raw.version !== BASELINE_VERSION) return null
    return raw
  } catch {
    return null
  }
}

export function saveBaseline(path: string, baseline: Baseline): void {
  const sorted: Baseline = {
    version: BASELINE_VERSION,
    findings: [...new Set(baseline.findings)].sort(),
    floors: baseline.floors,
  }
  writeFileSync(path, JSON.stringify(sorted, null, 2) + '\n')
}

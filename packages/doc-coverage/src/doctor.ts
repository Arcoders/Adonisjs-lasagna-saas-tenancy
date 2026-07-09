/**
 * The orchestrator: build the graph, compute coverage, run the four signals.
 * Returns a single result the CLI formats (report) or enforces (gate). Pure
 * computation, no process exit, no I/O beyond reading the repo.
 */
import type { DocCoverageConfig } from './config.js'
import { buildGraph } from './graph.js'
import { computeCoverage } from './coverage.js'
import type { CoverageReport } from './coverage.js'
import {
  d2soft,
  d2hard,
  d3freshness,
  d4reach,
  type D2SoftFinding,
  type D2HardFinding,
  type D3Finding,
  type D4Finding,
} from './signals.js'
import type { DocGraph } from './types.js'
import type { FreshnessCheckpoint } from './freshness.js'

export interface DoctorOptions {
  since?: string | undefined
  /** Committed contract-hash checkpoint for D3; absent means timestamp fallback. */
  freshness?: FreshnessCheckpoint | null
}

export interface DoctorResult {
  graph: DocGraph
  coverage: CoverageReport
  d2hard: D2HardFinding[]
  d2soft: D2SoftFinding[]
  d3: D3Finding[]
  d4: D4Finding[]
  warnings: string[]
  /** Pages that opted out of D3 (for `--update-freshness` to honor the same set). */
  freshnessIgnore: string[]
}

export function runDoctor(config: DocCoverageConfig, opts: DoctorOptions = {}): DoctorResult {
  const { graph, warnings, freshnessIgnore } = buildGraph(config)
  const ignored = new Set(freshnessIgnore)
  return {
    graph,
    coverage: computeCoverage(graph),
    d2hard: d2hard(graph, config),
    d2soft: d2soft(graph, config),
    d3: d3freshness(graph, config, {
      since: opts.since,
      freshness: opts.freshness,
      freshnessIgnore: ignored,
    }),
    d4: d4reach(graph, config, opts),
    warnings,
    freshnessIgnore,
  }
}

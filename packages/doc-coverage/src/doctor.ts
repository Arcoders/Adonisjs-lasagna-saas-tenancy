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

export interface DoctorOptions {
  since?: string
}

export interface DoctorResult {
  graph: DocGraph
  coverage: CoverageReport
  d2hard: D2HardFinding[]
  d2soft: D2SoftFinding[]
  d3: D3Finding[]
  d4: D4Finding[]
  warnings: string[]
}

export function runDoctor(config: DocCoverageConfig, opts: DoctorOptions = {}): DoctorResult {
  const { graph, warnings } = buildGraph(config)
  return {
    graph,
    coverage: computeCoverage(graph),
    d2hard: d2hard(graph, config),
    d2soft: d2soft(graph, config),
    d3: d3freshness(graph, config, opts),
    d4: d4reach(graph, config, opts),
    warnings,
  }
}

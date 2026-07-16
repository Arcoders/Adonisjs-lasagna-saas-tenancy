/**
 * @adonisjs-lasagna/doc-coverage: the deterministic documentation-drift engine.
 * Public API for the CLI and the gate scripts. See docs/dev/doc-coverage-rfc.md.
 */
export type {
  NodeKind,
  EdgeType,
  Provenance,
  Confidence,
  GraphNode,
  GraphEdge,
  DocGraph,
  JsDocContract,
} from './types.js'
export { SCHEMA_VERSION, DOCUMENTABLE_KINDS } from './types.js'

export type { DocCoverageConfig, PackageSpec } from './config.js'
export { defaultConfig, discoverPackages, findRepoRoot, rel } from './config.js'

export type { BuildResult } from './graph.js'
export { buildGraph } from './graph.js'

export type { BarrelSpec, DocAnchor, CodeNodeResult } from './symbols.js'
export { buildCodeNodes } from './symbols.js'

export type { MethodContract, SymbolContract } from './contract.js'
export { buildSymbolContract, normalizeType, throwsOf } from './contract.js'

export type { SynonymMap, TokenDiff } from './tokenize.js'
export { tokenize, tokenSet, withSynonyms, diffTokens, PARAM_STOPLIST } from './tokenize.js'

export { conventionKind, readKindDoc, resolveKind } from './kinds.js'

export type { CoverageStatus, CoverageRow, CoverageReport } from './coverage.js'
export { computeCoverage } from './coverage.js'

export type { D2SoftFinding, D2HardFinding, D3Finding, D4Finding } from './signals.js'
export { d2soft, d2hard, d3freshness, d4reach } from './signals.js'

export type { DoctorOptions, DoctorResult } from './doctor.js'
export { runDoctor } from './doctor.js'

export type { Severity, SeverityConfig, GateFinding, GateOutcome } from './gate.js'
export { runGate, DEFAULT_SEVERITY } from './gate.js'

export type { Baseline } from './baseline.js'
export { loadBaseline, saveBaseline, BASELINE_VERSION } from './baseline.js'

export { formatHuman, formatJson, formatJobSummary } from './report.js'
export { main } from './cli.js'

export type { RfcStatusItem, ChecklistLine } from './rfc_status.js'
export { RFC_STATUS, parseRfcChecklist } from './rfc_status.js'

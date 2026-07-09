/**
 * Tests for the contract-aware D3 freshness signal (RFC §6/§8). The signal fires
 * only when a symbol's contract hash differs from the hash recorded in the
 * committed checkpoint, so a comment-only edit is silent by construction (the bug
 * that produced the 57 false positives after the JSDoc backfill). It watches
 * `exemplifies` edges as well as `documents` ones, honors a page-level
 * `doc:freshness-ignore`, and falls back to the old timestamp heuristic only when
 * no checkpoint exists. The report prints the full list, never a silent slice.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { d3freshness, freshnessPairings } from '../src/signals.js'
import { saveFreshness, loadFreshness, FRESHNESS_VERSION } from '../src/freshness.js'
import { formatHuman } from '../src/report.js'
import type { DocCoverageConfig } from '../src/config.js'
import type { DocGraph, GraphNode } from '../src/types.js'
import type { DoctorResult } from '../src/doctor.js'
import type { GateOutcome } from '../src/gate.js'

const SYM = '@x/services#Svc'
// A real, stable doc path: contract mode never reads it (it is only a checkpoint
// key), and using a path that resolves keeps the check-doc-paths guard green.
const PAGE = 'docs/guides/documentation-coverage.md'

/** A one-service graph: the symbol carries `hash`, linked from PAGE by `edgeType`. */
function graphWith(edgeType: 'documents' | 'exemplifies', hash: string): DocGraph {
  const node: GraphNode = {
    id: SYM,
    kind: 'service',
    package: '@x',
    publicPath: SYM,
    internalPath: 'packages/x/src/services/svc.ts',
    signatureHash: hash,
    jsdoc: {
      members: [],
      allMembers: [],
      params: [],
      throws: [],
      returnsTypeStr: null,
      descriptionWordCount: 0,
    },
    sourceRange: { line: 1 },
    generated: false,
  }
  const page: GraphNode = {
    ...node,
    id: PAGE,
    kind: 'doc-page',
    publicPath: null,
    internalPath: PAGE,
    signatureHash: null,
    jsdoc: null,
  }
  return {
    schemaVersion: 1,
    nodes: [node, page],
    edges: [
      {
        from: PAGE,
        to: SYM,
        type: edgeType,
        provenance: edgeType === 'documents' ? 'declared:manual' : 'derived:auto',
        confidence: 'high',
        at: { from: `${PAGE}:1`, to: null },
      },
    ],
  }
}

function cfg(repoRoot = '/nonexistent'): DocCoverageConfig {
  return {
    repoRoot,
    docsRoots: [],
    packages: [],
    synonyms: {},
    coverageFloors: { explained: 0, exemplified: 0 },
    freshnessWindowDays: 0,
  }
}

const checkpoint = (reviewed: Record<string, string>) => ({ version: FRESHNESS_VERSION, reviewed })

test('contract mode: a matching checkpoint hash yields no finding', () => {
  const out = d3freshness(graphWith('documents', 'h1'), cfg(), {
    freshness: checkpoint({ [`${SYM}|${PAGE}`]: 'h1' }),
  })
  assert.equal(out.length, 0)
})

test('contract mode: a changed contract hash fires', () => {
  const out = d3freshness(graphWith('documents', 'h2'), cfg(), {
    freshness: checkpoint({ [`${SYM}|${PAGE}`]: 'h1' }),
  })
  assert.equal(out.length, 1)
  assert.match(out[0]!.reason, /contract changed/)
})

test('contract mode: a never-reviewed pairing fires', () => {
  const out = d3freshness(graphWith('documents', 'h1'), cfg(), { freshness: checkpoint({}) })
  assert.equal(out.length, 1)
})

test('contract mode: a comment-only edit (same hash) stays silent', () => {
  // The whole point: re-running after a JSDoc-only change does not move the hash,
  // so the pairing the maintainer already reviewed never re-flags.
  const reviewed = checkpoint({ [`${SYM}|${PAGE}`]: 'h1' })
  assert.equal(d3freshness(graphWith('documents', 'h1'), cfg(), { freshness: reviewed }).length, 0)
})

test('D3 watches exemplifies edges (unlike D2-soft), so a stale example fires', () => {
  const out = d3freshness(graphWith('exemplifies', 'h2'), cfg(), {
    freshness: checkpoint({ [`${SYM}|${PAGE}`]: 'h1' }),
  })
  assert.equal(out.length, 1)
})

test('a doc:freshness-ignore page is suppressed', () => {
  const out = d3freshness(graphWith('documents', 'h2'), cfg(), {
    freshness: checkpoint({}),
    freshnessIgnore: new Set([PAGE]),
  })
  assert.equal(out.length, 0)
})

test('freshnessPairings dedups documents+exemplifies from the same page and honors ignore', () => {
  const g = graphWith('documents', 'h1')
  g.edges.push({
    from: PAGE,
    to: SYM,
    type: 'exemplifies',
    provenance: 'derived:auto',
    confidence: 'high',
    at: { from: `${PAGE}:1`, to: null },
  })
  assert.equal(freshnessPairings(g).length, 1, 'one pairing per (symbol, page)')
  assert.equal(freshnessPairings(g, new Set([PAGE])).length, 0, 'ignored page yields no pairing')
})

test('no checkpoint + no git: timestamp fallback degrades to empty without crashing', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'doccov-fresh-'))
  try {
    const out = d3freshness(graphWith('documents', 'h1'), cfg(repoRoot), {})
    assert.equal(out.length, 0)
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('the checkpoint round-trips and sorts its keys deterministically', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'doccov-fresh-'))
  try {
    const path = join(repoRoot, 'doc-coverage.freshness.json')
    saveFreshness(path, checkpoint({ 'b|p': '2', 'a|p': '1' }))
    const loaded = loadFreshness(path)
    assert.ok(loaded)
    assert.deepEqual(Object.keys(loaded!.reviewed), ['a|p', 'b|p'], 'keys are sorted')
    assert.equal(loaded!.reviewed['a|p'], '1')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('the report prints the whole freshness list, not a silent slice', () => {
  const d3 = Array.from({ length: 60 }, (_, i) => ({
    symbol: `@x#S${i}`,
    doc: `docs/p${i}.md`,
    reason: 'contract changed since the doc was last reviewed',
  }))
  const result = {
    graph: { schemaVersion: 1, nodes: [], edges: [] },
    coverage: {
      pct: { explained: 100, exemplified: 0, uncovered: 0 },
      total: 0,
      explained: 0,
      exemplified: 0,
      uncovered: 0,
      rows: [],
    },
    d2hard: [],
    d2soft: [],
    d3,
    d4: [],
    warnings: [],
    freshnessIgnore: [],
  } as unknown as DoctorResult
  const gate = { blocking: [], warnings: [], coverageFloorOk: true, allKeys: [] } as GateOutcome
  const text = formatHuman(result, gate)
  const shown = text.split('\n').filter((l) => l.startsWith('  - ')).length
  assert.equal(shown, 50, 'shows up to 50 items inline')
  assert.match(text, /\(\+10 more freshness item/, 'and accounts for the rest explicitly')
})

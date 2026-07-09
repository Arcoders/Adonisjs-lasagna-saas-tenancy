/**
 * Golden-fixture test over a tiny self-contained repo (tests/fixtures/mini). It
 * seeds the known cases the tool must catch: barrel re-export resolution, an
 * explained symbol (front-matter `code:` + prose), an uncovered symbol, a fence
 * edge, and a dead-member reference in prose (the D2-hard gate signal).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { discoverPackages, type DocCoverageConfig } from '../src/config.js'
import { buildGraph } from '../src/graph.js'
import { runDoctor } from '../src/doctor.js'
import { computeCoverage } from '../src/coverage.js'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = join(here, 'fixtures', 'mini')

function fixtureConfig(): DocCoverageConfig {
  return {
    repoRoot,
    docsRoots: [join(repoRoot, 'docs')],
    packages: discoverPackages(repoRoot),
    synonyms: {},
    coverageFloors: { explained: 0, exemplified: 0 },
    freshnessWindowDays: 0,
  }
}

test('discovers the fixture package and its /services barrel', () => {
  const pkgs = discoverPackages(repoRoot)
  assert.equal(pkgs.length, 1)
  assert.equal(pkgs[0]!.name, '@mini/widgets')
  assert.ok(pkgs[0]!.barrels.some((b) => b.subpath === 'services'))
})

test('barrel resolution: WidgetService resolves to its internal file with a contract hash', () => {
  const { graph } = buildGraph(fixtureConfig())
  const ws = graph.nodes.find((n) => n.publicPath?.endsWith('#WidgetService'))
  assert.ok(ws, 'WidgetService node exists')
  // The public path is the /services barrel, not the root re-export.
  assert.equal(ws!.publicPath, '@mini/widgets/services#WidgetService')
  assert.match(ws!.internalPath!, /services\/widget_service\.ts$/)
  assert.equal(ws!.kind, 'service')
  assert.ok(ws!.signatureHash, 'has a contract hash')
  assert.deepEqual(ws!.jsdoc!.members.sort(), ['build', 'reset'])
  assert.ok(ws!.jsdoc!.throws.includes('RangeError'))
})

test('coverage: front-matter + prose makes WidgetService explained; GadgetService is uncovered', () => {
  const { graph } = buildGraph(fixtureConfig())
  const cov = computeCoverage(graph)
  const ws = cov.rows.find((r) => r.id.endsWith('#WidgetService'))!
  const gs = cov.rows.find((r) => r.id.endsWith('#GadgetService'))!
  assert.equal(ws.status, 'explained')
  assert.equal(gs.status, 'uncovered')
})

test('edges: a declared:manual documents edge and a fence exemplifies edge to WidgetService', () => {
  const { graph } = buildGraph(fixtureConfig())
  const incoming = graph.edges.filter((e) => e.to === '@mini/widgets/services#WidgetService')
  assert.ok(
    incoming.some((e) => e.type === 'documents' && e.provenance === 'declared:manual'),
    'declared documents edge from front-matter code:'
  )
  assert.ok(
    incoming.some((e) => e.type === 'exemplifies' && e.provenance === 'derived:auto'),
    'fence exemplifies edge'
  )
})

test('D2-hard: the dead WidgetService.frobnicate() prose call is flagged', () => {
  const result = runDoctor(fixtureConfig())
  const dead = result.d2hard.filter((f) => f.member === 'frobnicate')
  assert.equal(dead.length, 1)
  assert.ok(dead[0]!.symbol.endsWith('#WidgetService'))
})

test('graph output is deterministic (stable across two builds)', () => {
  const a = JSON.stringify(buildGraph(fixtureConfig()).graph)
  const b = JSON.stringify(buildGraph(fixtureConfig()).graph)
  assert.equal(a, b)
})

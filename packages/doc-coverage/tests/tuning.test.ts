/**
 * Tests for the D2-soft tuning added after the first full repo run: the member
 * token stoplist, the extended param stoplist, the committed `doc-synonyms.json`,
 * and the change that scopes D2-soft to `documents` edges (so an example fence no
 * longer demands the page enumerate the symbol's vocabulary).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { MEMBER_TOKEN_STOPLIST, PARAM_STOPLIST, tokenize } from '../src/tokenize.js'
import { defaultConfig, findRepoRoot, type DocCoverageConfig } from '../src/config.js'
import { d2soft } from '../src/signals.js'
import type { DocGraph, GraphNode } from '../src/types.js'

const here = dirname(fileURLToPath(import.meta.url))

test('member stoplist drops structural verbs but keeps the domain token', () => {
  // `clearCache` -> {clear, cache}, both structural; `meterUsage` -> {meter, usage}.
  const filter = (member: string): string[] =>
    tokenize(member).filter((t) => !MEMBER_TOKEN_STOPLIST.has(t))
  assert.deepEqual(filter('clearCache'), [])
  assert.deepEqual(filter('meterUsage'), ['meter', 'usage'])
  assert.deepEqual(filter('handle'), []) // middleware/exception contract method
  // Domain method words are deliberately NOT stoplisted, so a real gap still fires.
  for (const domain of ['meter', 'sync', 'verify', 'discover', 'recompute', 'replay']) {
    assert.ok(!MEMBER_TOKEN_STOPLIST.has(domain), `${domain} must stay a signal`)
  }
})

test('param stoplist gained the generic fragments without losing the originals', () => {
  for (const t of ['now', 'idx', 'threshold', 'err']) assert.ok(PARAM_STOPLIST.has(t))
  for (const t of ['opts', 'cb', 'ctx']) assert.ok(PARAM_STOPLIST.has(t))
})

test('doc-synonyms.json is committed at the repo root and loads', () => {
  const repoRoot = findRepoRoot(here)
  const { synonyms } = defaultConfig(repoRoot)
  assert.deepEqual(synonyms.assigned, ['assign'])
  assert.ok(Array.isArray(synonyms.verify) && synonyms.verify.includes('verification'))
})

/** Build a one-service graph whose page lacks the "meter" token, with the given edge type. */
function fixtureGraph(repoRoot: string, edgeType: 'documents' | 'exemplifies'): DocGraph {
  // A synthetic fixture path kept out of the `docs/` namespace so the
  // check-doc-paths guard does not mistake it for a real (missing) doc reference.
  const docId = 'site/x.md'
  const sym = '@x/services#BillingService'
  const node: GraphNode = {
    id: sym,
    kind: 'service',
    package: '@x',
    publicPath: sym,
    internalPath: 'packages/x/src/services/billing_service.ts',
    signatureHash: 'h',
    jsdoc: {
      members: ['clearCache', 'meterUsage'],
      allMembers: ['clearCache', 'meterUsage'],
      params: [],
      throws: [],
      returnsTypeStr: null,
      descriptionWordCount: 0,
    },
    sourceRange: { line: 1 },
    generated: false,
  }
  return {
    schemaVersion: 1,
    nodes: [node, { ...node, id: docId, kind: 'doc-page', publicPath: null, jsdoc: null }],
    edges: [
      {
        from: docId,
        to: sym,
        type: edgeType,
        provenance: edgeType === 'documents' ? 'declared:manual' : 'derived:auto',
        confidence: 'high',
        at: { from: `${docId}:1`, to: null },
      },
    ],
  }
}

test('D2-soft fires on a documents edge but ignores an exemplifies-only edge', () => {
  const repoRoot = mkdtempSync(join(tmpdir(), 'doccov-tune-'))
  try {
    mkdirSync(join(repoRoot, 'site'), { recursive: true })
    // Prose covers "usage" but not "meter"; "clear"/"cache" are stoplisted so they
    // must never be reported as missing regardless of the prose.
    writeFileSync(join(repoRoot, 'site', 'x.md'), 'The billing service records usage.\n')
    const config: DocCoverageConfig = {
      repoRoot,
      docsRoots: [join(repoRoot, 'site')],
      packages: [],
      synonyms: {},
      coverageFloors: { explained: 0, exemplified: 0 },
      freshnessWindowDays: 0,
    }

    const onDocuments = d2soft(fixtureGraph(repoRoot, 'documents'), config)
    assert.equal(onDocuments.length, 1, 'a documents edge is checked')
    assert.deepEqual(onDocuments[0].missing, ['meter'], 'only the domain token is missing')

    const onExemplifies = d2soft(fixtureGraph(repoRoot, 'exemplifies'), config)
    assert.equal(onExemplifies.length, 0, 'an exemplifies-only edge is not checked')
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

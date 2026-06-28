/**
 * The tool checks its own RFC (RFC §11). Parse the implementation checklist and
 * assert every box's state matches the implementation registry, in both
 * directions: a ticked box must be implemented, and an implemented item must be
 * ticked. Each checklist line must map to exactly one registry entry.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { findRepoRoot } from '../src/config.js'
import { RFC_STATUS, parseRfcChecklist } from '../src/rfc_status.js'

const here = dirname(fileURLToPath(import.meta.url))
const rfcPath = join(findRepoRoot(here), 'docs', 'dev', 'doc-coverage-rfc.md')

test('RFC §11 checklist exists and is non-trivial', () => {
  const items = parseRfcChecklist(readFileSync(rfcPath, 'utf8'))
  assert.ok(items.length >= RFC_STATUS.length, `expected >= ${RFC_STATUS.length} checklist lines`)
})

test('every RFC checkbox matches the implementation registry', () => {
  const items = parseRfcChecklist(readFileSync(rfcPath, 'utf8'))
  for (const item of items) {
    const matches = RFC_STATUS.filter((r) => item.text.includes(r.matcher))
    assert.equal(
      matches.length,
      1,
      `checklist line "${item.text}" must map to exactly one registry entry (got ${matches.length})`
    )
    assert.equal(
      item.checked,
      matches[0].implemented,
      `RFC checkbox for "${matches[0].key}" (${item.checked ? '[x]' : '[ ]'}) disagrees with the registry (implemented=${matches[0].implemented})`
    )
  }
})

test('every registry entry appears once in the RFC checklist', () => {
  const items = parseRfcChecklist(readFileSync(rfcPath, 'utf8'))
  for (const r of RFC_STATUS) {
    const hits = items.filter((i) => i.text.includes(r.matcher))
    assert.equal(
      hits.length,
      1,
      `registry entry "${r.key}" must appear exactly once in the RFC checklist`
    )
  }
})

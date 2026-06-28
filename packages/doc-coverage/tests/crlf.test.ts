/**
 * Cross-OS regression: a doc committed with CRLF line endings (Windows) must
 * parse identically to LF. Front-matter `code:` anchors are the canary, since
 * their regex is anchored on `\n`. Guards the determinism promise in the RFC.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildDocNodes } from '../src/docs.js'

function runOn(eol: '\r\n' | '\n'): ReturnType<typeof buildDocNodes> {
  const root = mkdtempSync(join(tmpdir(), 'doccov-eol-'))
  const docsRoot = join(root, 'docs')
  mkdirSync(docsRoot, { recursive: true })
  const page = [
    '---',
    'title: X',
    'code:',
    '  - "@mini/pkg#Foo"',
    '---',
    '',
    '# Hi',
    '',
    'Uses `Foo`.',
    '',
  ].join(eol)
  writeFileSync(join(docsRoot, 'page.md'), page)
  try {
    return buildDocNodes({
      docsRoot,
      repoRoot: root,
      knownPublicPaths: new Set(['@mini/pkg#Foo']),
      nameIndex: new Map([['Foo', ['@mini/pkg#Foo']]]),
      fileIndex: new Map(),
      docsLabel: 'docs',
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('CRLF front-matter code: anchors yield the same declared edge as LF', () => {
  const crlf = runOn('\r\n')
  const lf = runOn('\n')
  const declaredCrlf = crlf.edges.filter(
    (e) => e.to === '@mini/pkg#Foo' && e.provenance === 'declared:manual'
  )
  const declaredLf = lf.edges.filter(
    (e) => e.to === '@mini/pkg#Foo' && e.provenance === 'declared:manual'
  )
  assert.equal(declaredCrlf.length, 1, 'CRLF front-matter still parses the code: anchor')
  assert.equal(declaredLf.length, 1, 'LF front-matter parses the code: anchor')
})

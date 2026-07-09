#!/usr/bin/env node
// Guards that every provider CLASS defines only the PUBLIC methods AdonisJS
// actually calls — the lifecycle set the SatelliteProviderContract declares
// ({register, boot, start, ready, shutdown}, plus the constructor). A public
// method outside that set is never invoked by the framework, so it silently
// no-ops: crypto's old `async disconnect()` is the canonical regression (the
// guard-metric sink it tore down leaked, because AdonisJS never called it; it is
// now the facade's `shutdown`). Private (`#`-prefixed) or `private`/`protected`
// members are implementation detail and ignored.
//
// A provider comes in two shapes, both covered:
//   1. a `definePlugin({ ... })` facade — the only class implementing the contract
//      lives in sdk/define_plugin.ts (this guard pins it so the facade itself can't
//      grow a stray lifecycle method), and the spec is a CLOSED interface so a raw
//      provider source has no class here to scan;
//   2. a hand-written `class X implements SatelliteProviderContract` (the documented
//      escape hatch) — scanned wherever a discovered provider source declares one.
//
// The allowed set is MIRRORED from the interface in packages/core/src/sdk/contract.ts,
// so it can never drift from the real contract. plugin-platform Wave 3. Ships --self-test.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { discoverSatelliteProviders } from './lib/discover-satellites.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const CONTRACT_FILE = 'packages/core/src/sdk/contract.ts'
const FACADE_FILE = 'packages/core/src/sdk/define_plugin.ts'

const CONTRACT_MARKER = 'implements SatelliteProviderContract'

/**
 * The lifecycle methods AdonisJS calls, read from the SatelliteProviderContract
 * interface so the allow-list can't drift from the contract. `constructor` is
 * always allowed. Returns a Set, or null when the interface can't be parsed.
 */
export function allowedMethodsFrom(contractSrc) {
  const m = contractSrc.match(/interface\s+SatelliteProviderContract\s*\{([\s\S]*?)\n\}/)
  if (!m) return null
  const names = new Set(['constructor'])
  for (const line of m[1].split('\n')) {
    const mm = line.match(/^\s*(\w+)\??\s*\(/)
    if (mm) names.add(mm[1])
  }
  return names
}

/**
 * Replace the CONTENTS of line comments, block comments, and string/template
 * literals with spaces (newlines preserved), so brace/paren counting and member
 * matching never trip on a `{`, `(`, or `name(` that lives inside a comment or a
 * string. Cheap single pass; robust enough for the provider files it scans (no
 * regex literals at class-member level), and pinned by --self-test.
 */
export function scrub(src) {
  let out = ''
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    const d = src[i + 1]
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && d === '*') {
      out += '  '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += '  '
        i += 2
      }
      continue
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c
      out += ' '
      i++
      while (i < n && src[i] !== q) {
        if (src[i] === '\\') {
          out += '  '
          i += 2
          continue
        }
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out += ' '
        i++
      }
      continue
    }
    out += c
    i++
  }
  return out
}

const ID = '[A-Za-z_$][\\w$]*'
const MODIFIERS = '(?:public|private|protected|static|readonly|abstract|override|async|get|set)'
// A class-member method declaration, anchored at a token start: optional modifiers,
// then the (optionally `#`-private) name, optional generics, then `(`.
const MEMBER_RE = new RegExp(`^((?:${MODIFIERS}\\b\\s+)*)(#?${ID})\\s*(?:<[^;{}()]*>)?\\s*\\(`)

function isTokenStart(s, i) {
  return i === 0 || !/[\w$#]/.test(s[i - 1])
}

/**
 * The public method names declared DIRECTLY in the first `class ... implements
 * SatelliteProviderContract` in `src`, or null when the file declares no such
 * class (a definePlugin provider source). Walks the SCRUBBED source tracking brace
 * + paren depth, so only true class members (brace/paren depth 0 inside the class
 * body) are matched — never a bare call or control statement inside a method body.
 * `#`-private and `private`/`protected` members are excluded (implementation detail).
 */
export function providerPublicMethods(src) {
  const scrubbed = scrub(src)
  const marker = scrubbed.indexOf(CONTRACT_MARKER)
  if (marker === -1) return null
  const open = scrubbed.indexOf('{', marker)
  if (open === -1) return null

  const names = []
  let brace = 0
  let paren = 0
  let i = open + 1
  const s = scrubbed
  const n = s.length
  while (i < n) {
    const c = s[i]
    if (c === '{') {
      brace++
      i++
      continue
    }
    if (c === '}') {
      if (brace === 0) break // end of the class body
      brace--
      i++
      continue
    }
    if (c === '(') {
      paren++
      i++
      continue
    }
    if (c === ')') {
      if (paren > 0) paren--
      i++
      continue
    }
    // Member declarations live at the class-body top level: brace 0, paren 0.
    if (brace === 0 && paren === 0 && isTokenStart(s, i)) {
      const m = MEMBER_RE.exec(s.slice(i))
      if (m) {
        const modifiers = m[1]
        const name = m[2]
        const isPrivate = name.startsWith('#') || /\b(private|protected)\b/.test(modifiers)
        if (!isPrivate) names.push(name)
        // Advance onto the `(` so the paren handler counts the params, and member
        // detection only resumes once this method's signature + body have closed.
        i += m[0].length - 1
        continue
      }
    }
    i++
  }
  return names
}

/** Pure rule: given a provider source + the allowed set, return problems. */
export function lint(src, allowed) {
  const methods = providerPublicMethods(src)
  if (methods === null) return [] // no contract class (a definePlugin facade source)
  const problems = []
  for (const name of methods) {
    if (!allowed.has(name)) {
      problems.push(
        `public method "${name}()" is not a SatelliteProviderContract lifecycle hook ` +
          `(${[...allowed].filter((a) => a !== 'constructor').join(', ')}); AdonisJS will never ` +
          `call it, so it silently no-ops. Move the work into a real lifecycle hook (e.g. shutdown).`
      )
    }
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const failures = []
  const allowed = new Set(['constructor', 'register', 'boot', 'start', 'ready', 'shutdown'])

  // allow-list is parsed from the contract interface
  const parsed = allowedMethodsFrom(
    `export interface SatelliteProviderContract {\n  register?(): void\n  boot?(): void\n  start?(): void\n  ready?(): void\n  shutdown?(): void\n}\n`
  )
  if (!parsed || !['register', 'boot', 'start', 'ready', 'shutdown'].every((n) => parsed.has(n))) {
    failures.push('allowedMethodsFrom did not parse the contract interface')
  }

  const cls = (body) => `class Foo implements SatelliteProviderContract {\n${body}\n}`
  // good: only lifecycle + private + constructor
  if (
    lint(
      cls('  constructor(app) {}\n  async register() {}\n  async boot() {}\n  async #runHook() {}'),
      allowed
    ).length !== 0
  ) {
    failures.push('good provider class flagged')
  }
  // stray public disconnect() → flagged
  if (lint(cls('  async boot() {}\n  async disconnect() {}'), allowed).length === 0) {
    failures.push('stray disconnect() passed')
  }
  // private/protected stray → ignored
  if (lint(cls('  private cleanup() {}\n  protected teardown() {}\n  boot() {}'), allowed).length !== 0) {
    failures.push('private/protected stray flagged')
  }
  // a bare call / control statement inside a method body is NOT a member
  if (
    lint(
      cls(
        '  async boot() {\n    assertSatelliteApiCompatAtBoot({ satelliteApi: 1 }, "l")\n    for (const x of []) helper(x)\n  }'
      ),
      allowed
    ).length !== 0
  ) {
    failures.push('call inside method body flagged as a member')
  }
  // a `name(` inside a string / comment is NOT a member
  if (lint(cls('  boot() {\n    const s = "disconnect()"\n    // dispose()\n  }'), allowed).length !== 0) {
    failures.push('name() inside string/comment flagged')
  }
  // a definePlugin facade source (no contract class here) → nothing to check
  if (lint("export default definePlugin({ name: 'x', shutdown() {} })", allowed).length !== 0) {
    failures.push('definePlugin source without a contract class flagged')
  }
  // the real facade class must pass (it lives in define_plugin.ts)
  if (existsSync(r(FACADE_FILE))) {
    const problems = lint(readFileSync(r(FACADE_FILE), 'utf8'), allowed)
    if (problems.length !== 0) failures.push(`facade class flagged: ${problems.join('; ')}`)
  }

  if (failures.length) {
    console.error('check-provider-lifecycle --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-provider-lifecycle --self-test: OK')
  process.exit(0)
}

const contractSrc = existsSync(r(CONTRACT_FILE)) ? readFileSync(r(CONTRACT_FILE), 'utf8') : ''
const allowed = allowedMethodsFrom(contractSrc)
if (!allowed) {
  console.error(`check-provider-lifecycle: cannot parse SatelliteProviderContract in ${CONTRACT_FILE}`)
  process.exit(2)
}

const files = [FACADE_FILE, ...discoverSatelliteProviders(ROOT).map((s) => s.provider)]
const errors = []
let scanned = 0
for (const rel of files) {
  if (!existsSync(r(rel))) continue
  scanned++
  for (const p of lint(readFileSync(r(rel), 'utf8'), allowed)) {
    errors.push(`${rel}: ${p}`)
  }
}

if (errors.length > 0) {
  console.error('check-provider-lifecycle: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-provider-lifecycle: OK (${scanned} provider source(s) scanned)`)

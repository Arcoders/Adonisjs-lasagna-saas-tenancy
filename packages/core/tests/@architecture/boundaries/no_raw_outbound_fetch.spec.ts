import { test } from '@japa/runner'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * Anti-regression guard for WS-4: all outbound HTTP the package makes goes
 * through the single hardened seam `safeFetch` (utils/safe_fetch.ts). No module
 * may call the global `fetch(` directly, nor import `request`/`get` from
 * `node:http` / `node:https`, because those bypass the SSRF validation, the
 * address pinning, and the redirect/timeout handling the seam centralizes.
 *
 * `safeFetch(` and a method call like `this.#deps.fetch(` are NOT flagged (the
 * former is the seam, the latter an injected, already-routed dependency).
 *
 * The walk covers EVERY `packages/<pkg>/src`, so a satellite that grows an
 * outbound call is held to the same seam without editing this spec.
 */

const PACKAGES_DIR = fileURLToPath(new URL('../../../../', import.meta.url))

// Files permitted to use raw outbound primitives, one entry per path + reason.
const ALLOWLIST: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: 'core/src/utils/safe_fetch.ts',
    why: 'IS the seam: owns the pinned https.request and the trusted-host/loopback fetch',
  },
]
const ALLOWED_PATHS = new Set(ALLOWLIST.map((e) => e.path))

const ALLOWED_OPT_OUT = /\/\/\s*safe-fetch-ok:/i

// Bare global fetch(, excluding `.fetch(` (a method/dep call) and `safeFetch(`
// (capital F, never matches a lowercase `fetch`). JS regex lookbehind is fine
// here (the spec runs on V8, not ripgrep).
const BARE_FETCH = /(?<![.\w$])fetch\s*\(/
// Importing the low-level request API from node:http / node:https.
const NODE_HTTP_IMPORT = /from\s+['"]node:https?['"]|require\(\s*['"]node:https?['"]\s*\)/

function srcRoots(): string[] {
  const roots: string[] = []
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, entry, 'src')
    if (existsSync(src) && statSync(src).isDirectory()) roots.push(src)
  }
  return roots
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

test.group('Architectural: outbound HTTP must route through safeFetch', () => {
  test('no module calls the global fetch() directly outside the seam', ({ assert }) => {
    const violations: string[] = []

    for (const root of srcRoots()) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(PACKAGES_DIR, file).replace(/\\/g, '/')
        if (ALLOWED_PATHS.has(rel)) continue
        const src = readFileSync(file, 'utf8')
        if (!BARE_FETCH.test(src)) continue

        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (isComment(line) || !BARE_FETCH.test(line)) return
          const window = lines.slice(Math.max(0, i - 1), i + 2)
          if (window.some((l) => ALLOWED_OPT_OUT.test(l))) return
          violations.push(`${rel}:${i + 1} — ${line.trim().slice(0, 100)}`)
        })
      }
    }

    assert.deepEqual(
      violations,
      [],
      [
        'Found a raw global fetch() call. Route it through safeFetch (core/src/utils/safe_fetch.ts):',
        'pinned mode for attacker-influenced destinations, { trustedHost: true } for a first-party',
        'API host. If this genuinely is the seam, add the path to ALLOWLIST.',
        '',
        'Violations:',
        ...violations.map((v) => '  - ' + v),
      ].join('\n')
    )
  })

  test('no module imports request/get from node:http(s) outside the seam', ({ assert }) => {
    const violations: string[] = []
    for (const root of srcRoots()) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(PACKAGES_DIR, file).replace(/\\/g, '/')
        if (ALLOWED_PATHS.has(rel)) continue
        const src = readFileSync(file, 'utf8')
        if (NODE_HTTP_IMPORT.test(src)) violations.push(rel)
      }
    }
    assert.deepEqual(
      violations,
      [],
      `node:http(s) imported outside safeFetch in: ${violations.join(', ')}`
    )
  })

  test('the allowlisted seam exists (allowlist is not stale)', ({ assert }) => {
    for (const { path } of ALLOWLIST) {
      assert.isTrue(
        existsSync(join(PACKAGES_DIR, path)),
        `allowlisted path no longer exists: ${path}`
      )
    }
  })

  test('the detector flags raw calls and ignores the safe ones (controls)', ({ assert }) => {
    const flagged = [`await fetch(url)`, `const r = fetch('https://x')`, `return fetch(u, init)`]
    const clean = [
      `await safeFetch(url, { trustedHost: true })`,
      `const r = this.#deps.fetch(endpoint, init)`,
      `obj.fetch(x)`,
    ]
    for (const s of flagged) assert.isTrue(BARE_FETCH.test(s), `should flag: ${s}`)
    for (const s of clean) assert.isFalse(BARE_FETCH.test(s), `should NOT flag: ${s}`)

    assert.isTrue(NODE_HTTP_IMPORT.test(`import { request } from 'node:https'`))
    assert.isTrue(NODE_HTTP_IMPORT.test(`import http from 'node:http'`))
    assert.isFalse(NODE_HTTP_IMPORT.test(`import { isIP } from 'node:net'`))
  })
})

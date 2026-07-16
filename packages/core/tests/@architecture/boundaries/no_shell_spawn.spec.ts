import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * Anti-regression guard for the security.md promise "No `shell: true` in
 * `spawn(...)`": `pg_dump`, `pg_restore`, and `psql` are spawned without a
 * shell on every platform, so cmd.exe / sh metacharacter interpretation is
 * never in the attack surface.
 *
 * The spec walks the core and backup `src/` trees and asserts:
 *   1. no `spawn()` / `spawnSync()` options object passes `shell: true`
 *      (or any truthy `shell:` value), and
 *   2. `child_process.exec` / `execSync` (which ALWAYS run through a
 *      shell) are never imported.
 *
 * `execFile` is deliberately allowed: like spawn, it takes an argv array
 * and no shell.
 */

const ROOTS = [
  fileURLToPath(new URL('../../../src/', import.meta.url)),
  // The backup satellite owns the pg_dump/pg_restore/psql call sites the
  // security page talks about. Resolved relative to the monorepo layout;
  // skipped gracefully if the package is ever vendored elsewhere.
  fileURLToPath(new URL('../../../../backup/src/', import.meta.url)),
]

// A `shell:` property with anything but an explicit `false` inside the two
// statements following a spawn/spawnSync call. Conservative on purpose: a
// future `shell: someVar` is flagged too. Make it a literal `false` or
// restructure.
const SHELL_TRUE = /shell\s*:(?!\s*false\b)/
const SPAWN_CALL = /\bspawn(?:Sync)?\(/
// The `node:` prefix is optional on purpose: `from 'child_process'` is
// equally valid ESM and must not slip past the gate.
const EXEC_IMPORT =
  /\b(?:exec|execSync)\b(?=[^(]*from\s+['"](?:node:)?child_process['"])|require\(['"](?:node:)?child_process['"]\)/

test.group('Architectural: child processes never get a shell', () => {
  test('no spawn() call site passes shell: true (core + backup src)', ({ assert }) => {
    const violations: string[] = []

    for (const root of ROOTS) {
      if (!existsSync(root)) continue
      for (const file of walkTsFiles(root)) {
        const src = readFileSync(file, 'utf8')
        if (!SPAWN_CALL.test(src)) continue

        const isComment = (l: string) => {
          const t = l.trim()
          return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
        }
        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (isComment(line) || !SPAWN_CALL.test(line)) return
          // Inspect the call line plus a short window after it. Option
          // objects in this codebase open on the call line and close
          // within a handful of lines. Comment lines are excluded so prose
          // that *mentions* `shell: true` can't trip the detector.
          const window = lines
            .slice(i, i + 6)
            .filter((l) => !isComment(l))
            .join('\n')
          if (SHELL_TRUE.test(window)) {
            violations.push(`${relative(root, file)}:${i + 1} — ${line.trim().slice(0, 100)}`)
          }
        })
      }
    }

    assert.deepEqual(
      violations,
      [],
      `Found spawn() call(s) that enable a shell — that reintroduces the ` +
        `command-injection surface security.md promises away:\n${violations.join('\n')}`
    )
  })

  test('child_process.exec / execSync are never imported (they always use a shell)', ({
    assert,
  }) => {
    const violations: string[] = []

    for (const root of ROOTS) {
      if (!existsSync(root)) continue
      for (const file of walkTsFiles(root)) {
        const src = readFileSync(file, 'utf8')
        if (EXEC_IMPORT.test(src)) {
          violations.push(relative(root, file))
        }
      }
    }

    assert.deepEqual(violations, [], `exec/execSync imported in: ${violations.join(', ')}`)
  })

  test('the shell detector catches the patterns we care about (positive controls)', ({
    assert,
  }) => {
    const flagged = [
      `spawn(cmd, args, { shell: true })`,
      `spawnSync('psql', ['-c', sql], {\n  shell: true,\n})`,
      `spawn(bin, argv, { env, shell: process.platform === 'win32' })`,
    ]
    const clean = [
      `spawn(cmd, args, { env, stdio: ['ignore', 'pipe', 'pipe'] })`,
      `spawn(this.#psqlBinary(), ['--version'])`,
      `spawn(cmd, args, { shell: false })`,
    ]
    for (const snippet of flagged) {
      assert.isTrue(SPAWN_CALL.test(snippet) && SHELL_TRUE.test(snippet), `should flag: ${snippet}`)
    }
    for (const snippet of clean) {
      assert.isFalse(SHELL_TRUE.test(snippet), `should NOT flag: ${snippet}`)
    }

    const flaggedImports = [
      `import { exec } from 'node:child_process'`,
      `import { execSync } from 'child_process'`,
      `const cp = require('child_process')`,
      `const cp = require('node:child_process')`,
    ]
    const cleanImports = [
      `import { execFile } from 'node:child_process'`,
      `import { spawn } from 'node:child_process'`,
    ]
    for (const snippet of flaggedImports) {
      assert.isTrue(EXEC_IMPORT.test(snippet), `should flag import: ${snippet}`)
    }
    for (const snippet of cleanImports) {
      assert.isFalse(EXEC_IMPORT.test(snippet), `should NOT flag import: ${snippet}`)
    }
  })
})

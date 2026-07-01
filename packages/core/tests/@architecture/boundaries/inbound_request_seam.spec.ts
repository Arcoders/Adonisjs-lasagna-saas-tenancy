import { test } from '@japa/runner'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * SEAM-4 guard: the raw inbound request (`ctx.request.request`, a Node
 * `IncomingMessage`) is touched in exactly ONE place — `onRequestDisconnect` in
 * `utils/signals.ts`, which bridges a client disconnect into an AbortSignal and
 * removes its listener on `dispose()`. Attaching a `'close'`/`'aborted'` listener
 * to that socket anywhere else is how a listener leaks and how disconnect handling
 * drifts from the sanctioned, disposed seam, so the whole `.request.request`
 * property access is fenced. Add a `// inbound-request-ok:` comment for a
 * deliberate exception.
 *
 * The walk covers EVERY `packages/<pkg>/src`, so a satellite that reaches for the
 * raw socket is held to the same seam without editing this spec.
 */

const PACKAGES_DIR = fileURLToPath(new URL('../../../../', import.meta.url))

const ALLOWLIST: ReadonlyArray<{ path: string; why: string }> = [
  {
    path: 'core/src/utils/signals.ts',
    why: 'IS the seam: onRequestDisconnect owns the raw inbound-request close listener',
  },
]
const ALLOWED_PATHS = new Set(ALLOWLIST.map((e) => e.path))
const ALLOWED_OPT_OUT = /\/\/\s*inbound-request-ok:/i

// Access to the raw Node IncomingMessage behind AdonisJS's Request wrapper. The
// `[?.]*` tolerates the optional-chaining form (`ctx.request?.request`). A regex
// drift-detector cannot catch bracket (`ctx.request['request']`) or aliased
// (`const r = ctx.request; r.request`) access; those are the residual, accepted
// because `ctx.request` is never nullable and the idiom is the dotted form.
const RAW_REQUEST = /\.request[?.]*\.request\b/

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

test.group('Architectural: raw inbound request behind onRequestDisconnect only', () => {
  test('no module reaches ctx.request.request outside utils/signals.ts', ({ assert }) => {
    const violations: string[] = []

    for (const root of srcRoots()) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(PACKAGES_DIR, file).replace(/\\/g, '/')
        if (ALLOWED_PATHS.has(rel)) continue
        const src = readFileSync(file, 'utf8')
        if (!RAW_REQUEST.test(src)) continue

        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (isComment(line) || !RAW_REQUEST.test(line)) return
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
        'Found a raw ctx.request.request access. Bridge a client disconnect via',
        'onRequestDisconnect(ctx) from utils/signals.ts (it owns the close listener and',
        'disposes it). If this is a deliberate exception, add a // inbound-request-ok: comment.',
        '',
        'Violations:',
        ...violations.map((v) => '  - ' + v),
      ].join('\n')
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

  test('the detector flags raw access and ignores lookalikes (controls)', ({ assert }) => {
    assert.isTrue(RAW_REQUEST.test(`ctx.request.request.on('close', fn)`))
    assert.isTrue(RAW_REQUEST.test(`const req = ctx.request.request`))
    assert.isTrue(
      RAW_REQUEST.test(`ctx.request?.request.on('close', fn)`),
      'optional-chaining form'
    )
    assert.isFalse(RAW_REQUEST.test(`ctx.request.header('host')`))
    assert.isFalse(RAW_REQUEST.test(`this.request(payload)`))
    assert.isFalse(RAW_REQUEST.test(`ctx.request.qs()`))
    assert.isFalse(RAW_REQUEST.test(`obj.request(x).request(y)`), 'method calls, not the raw prop')
  })
})

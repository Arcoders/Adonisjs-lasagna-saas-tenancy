#!/usr/bin/env node
// Bans a SILENTLY-swallowed catch on the new plugin-platform seam files: a
// `try { … } catch { … }` whose body neither logs, emits an isthmus event / a
// metric, nor rethrows is a fail-open hole (the exact class the plan's E3
// forbids). A global ban is infeasible (55 `catch {` in 29 core files predate
// this), so this is SCOPED to the dedicated plugin files, where a swallowed
// error is always a bug. A deliberate best-effort swallow opts out with a
// `// silent-catch-ok: <reason ≥ 20 chars>` annotation on/above the catch.
//
// Shares its detector with tests/@architecture/boundaries/no_silent_catch.spec.ts
// (that spec pins the same logic with controls). Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CORE = join(ROOT, 'packages/core')

// The dedicated plugin-surface files (a swallowed error here is a bug). Mixed
// files (extensions/router.ts, extensions/request.ts, middleware/*) carry
// intentional best-effort swallows and are deliberately out of scope.
const SCOPED_FILES = [
  'src/sdk/define_plugin.ts',
  'src/sdk/brands.ts',
  'src/sdk/assert_never.ts',
  'src/sdk/plugin_api_version.ts',
  'src/sdk/plugin.ts',
  'src/sdk/capabilities.ts',
  'src/services/authorizer_registry.ts',
  'src/services/tenant_middleware_registry.ts',
  'src/services/capability_registry.ts',
  'src/services/tenant_scheduler_service.ts',
  'src/services/plugin_data_change.ts',
]

// A catch body is "handled" if it logs, emits an isthmus event / metric, warns,
// or rethrows. `\blogger\b` covers `logger.` / `logger?.` / lazy `lazyLogger()`
// idioms, and `\?\.(?:error|warn|…)\(` covers the optional-chained log call this
// package uses everywhere — `(await lazyLogger())?.error(`. Both are anchored to a
// logger reference or an optional-chained log call, so a bare non-logger method
// like `result.error(e)` is NOT mistaken for handling. Comments mentioning `throw`
// can only make this MORE lenient (never a false positive), the safe direction.
const HANDLED =
  /\blogger\b|console\.|emitIsthmusEvent\(|emitMetric\(|warnMetrics\(|\bthrow\b|\?\.(?:error|warn|info|critical|fatal|debug)\(/
// ≥20 chars of reason after the marker.
const OK_ANNOTATION = /silent-catch-ok:\s*\S.{19,}/

/** Return the 1-based line numbers of silent catches in `src`. */
export function silentCatchLines(src) {
  const violations = []
  let i = 0
  while ((i = src.indexOf('catch', i)) !== -1) {
    // A try-catch's `catch` is preceded (skipping whitespace) by the try block's
    // closing `}`. This rejects `.catch(` (a Promise method) and identifiers
    // ending in "catch".
    let p = i - 1
    while (p >= 0 && /\s/.test(src[p])) p--
    if (src[p] !== '}') {
      i += 5
      continue
    }
    const open = src.indexOf('{', i)
    if (open === -1) break
    let depth = 0
    let k = open
    for (; k < src.length; k++) {
      if (src[k] === '{') depth++
      else if (src[k] === '}' && --depth === 0) break
    }
    const body = src.slice(open, k + 1)
    // Context = the two lines preceding the catch + the body, so an annotation
    // can sit on the catch line or just above it.
    const lineStart = src.lastIndexOf('\n', i)
    let ctxStart = src.lastIndexOf('\n', Math.max(0, lineStart - 1))
    if (ctxStart < 0) ctxStart = 0
    const context = src.slice(ctxStart, k + 1)
    if (!HANDLED.test(body) && !OK_ANNOTATION.test(context)) {
      violations.push(src.slice(0, i).split('\n').length)
    }
    i = k + 1
  }
  return violations
}

if (process.argv.includes('--self-test')) {
  const fails = []
  const silent = 'try { x() } catch { return undefined }'
  const logged = 'try { x() } catch (e) { logger.error(e) }'
  const rethrown = 'try { x() } catch (e) { throw new PluginBootException("x") }'
  const isthmus = 'try { x() } catch (e) { emitIsthmusEvent("guard.x") ; return d }'
  const promiseCatch = 'foo().catch(() => undefined)'
  const optChainLog = 'try { x() } catch (e) { (await lazyLogger())?.error(e) }'
  // A non-logger method named `error` must NOT count as handling (false-negative guard).
  const nonLoggerError = 'try { x() } catch (e) { result.error(e) ; return d }'
  const annotated =
    '// silent-catch-ok: best-effort registry resolve in unbooted ctx\ntry{x()}catch{ }'
  if (silentCatchLines(silent).length !== 1) fails.push('silent not flagged')
  if (silentCatchLines(logged).length !== 0) fails.push('logged flagged')
  if (silentCatchLines(rethrown).length !== 0) fails.push('rethrow flagged')
  if (silentCatchLines(isthmus).length !== 0) fails.push('isthmus-emit flagged')
  if (silentCatchLines(promiseCatch).length !== 0) fails.push('.catch() flagged')
  if (silentCatchLines(optChainLog).length !== 0) fails.push('optional-chained logger flagged')
  if (silentCatchLines(nonLoggerError).length !== 1) fails.push('non-logger .error() not flagged')
  if (silentCatchLines(annotated).length !== 0) fails.push('annotated flagged')
  if (fails.length) {
    console.error('check-no-silent-catch --self-test: FAIL')
    for (const f of fails) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-no-silent-catch --self-test: OK')
  process.exit(0)
}

const errors = []
for (const rel of SCOPED_FILES) {
  const file = join(CORE, rel)
  if (!existsSync(file)) {
    errors.push(`${rel}: scoped file no longer exists (update SCOPED_FILES)`)
    continue
  }
  for (const line of silentCatchLines(readFileSync(file, 'utf8'))) {
    errors.push(
      `${rel}:${line} — silent catch (log / emitIsthmusEvent / throw, or annotate // silent-catch-ok:)`
    )
  }
}

if (errors.length > 0) {
  console.error('check-no-silent-catch: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}
console.log(`check-no-silent-catch: OK (${SCOPED_FILES.length} plugin-surface files scanned)`)

import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * E3 guard: no silently-swallowed catch on the dedicated plugin-platform seam
 * files. A `catch` whose body neither logs, emits an isthmus event / metric, nor
 * rethrows is a fail-open hole. A global ban is infeasible (55 `catch {` in 29
 * core files predate this), so this is SCOPED to the new plugin files, where a
 * swallowed error is always a bug. A deliberate best-effort swallow opts out with
 * a `// silent-catch-ok: <reason ≥ 20 chars>` annotation.
 *
 * The detector mirrors scripts/check-no-silent-catch.mjs (the CI gate). This spec
 * pins the same logic with controls so the two cannot disagree on what "silent"
 * means; keep {@link silentCatchLines} + {@link SCOPED_FILES} in sync with it.
 */

const CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

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
] as const

const HANDLED = /logger\.|console\.|emitIsthmusEvent\(|emitMetric\(|warnMetrics\(|\bthrow\b/
const OK_ANNOTATION = /silent-catch-ok:\s*\S.{19,}/

function silentCatchLines(src: string): number[] {
  const violations: number[] = []
  let i = 0
  while ((i = src.indexOf('catch', i)) !== -1) {
    let p = i - 1
    while (p >= 0 && /\s/.test(src[p]!)) p--
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

test.group('Architectural: no silent catch on the plugin surface (E3)', () => {
  test('no scoped plugin file swallows a catch silently', ({ assert }) => {
    const violations: string[] = []
    for (const rel of SCOPED_FILES) {
      const file = CORE_ROOT + rel
      assert.isTrue(existsSync(file), `scoped file missing: ${rel}`)
      for (const line of silentCatchLines(readFileSync(file, 'utf8'))) {
        violations.push(`${rel}:${line}`)
      }
    }
    assert.deepEqual(
      violations,
      [],
      `Silent catch on the plugin surface (log / emitIsthmusEvent / throw, or ` +
        `annotate // silent-catch-ok: <why>):\n${violations.join('\n')}`
    )
  })

  test('the detector flags a silent catch but not handled / .catch() / annotated ones (controls)', ({
    assert,
  }) => {
    assert.lengthOf(silentCatchLines('try { x() } catch { return undefined }'), 1)
    assert.lengthOf(silentCatchLines('try { x() } catch (e) { logger.error(e) }'), 0)
    assert.lengthOf(
      silentCatchLines('try { x() } catch (e) { throw new PluginBootException("x") }'),
      0
    )
    assert.lengthOf(
      silentCatchLines('try { x() } catch { emitIsthmusEvent("guard.x"); return d }'),
      0
    )
    assert.lengthOf(silentCatchLines('foo().catch(() => undefined)'), 0)
    assert.lengthOf(
      silentCatchLines(
        '// silent-catch-ok: best-effort registry resolve in unbooted ctx\ntry{x()}catch{ }'
      ),
      0
    )
  })
})

import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * The kit's main barrel is imported at the TOP of a consumer's
 * `bin/test.integration.ts`, BEFORE the Ignitor creates the AdonisJS app. So the
 * eager module graph (`index` -> `run_integration_suite` -> `runner_logic`) must
 * not statically import any `@adonisjs/core/services/*` or
 * `@adonisjs/lucid/services/*` module. The app-dependent bootstrap is pulled in
 * LAZILY (`import('./bootstrap.js')` after boot) and the tenant helpers live on
 * the `/testing` subpath, off this path.
 *
 * Two guards with DIFFERENT coverage, not nested coverage. Both are load-bearing:
 *
 * - **Runtime import.** Proves the whole eager graph LOADS with no Ignitor. This
 *   catches a forbidden module whose body throws pre-boot, e.g.
 *   `@adonisjs/lucid/services/db` and `@adonisjs/core/services/test_utils`, which
 *   top-level-`await app.booted(...)` and throw when `app` is undefined (the
 *   original CI failure). It does NOT catch `@adonisjs/core/services/app`: that
 *   one imports cleanly pre-boot (its body just binds a mutable `app`), so a
 *   stray import of it would not throw here.
 * - **Source parse (transitive).** Walks the eager graph from the barrel,
 *   following relative imports, and rejects any forbidden static import in ANY
 *   reachable file. This is the SOLE guard for `@adonisjs/core/services/app`
 *   (import-clean pre-boot, invisible to the runtime test). `bootstrap.ts`
 *   imports exactly that module, so moving/adding it to an eager file is a
 *   realistic regression. The walk (rather than a hardcoded file list) means a
 *   newly added eager file is covered automatically.
 */

const FORBIDDEN = ['@adonisjs/core/services/', '@adonisjs/lucid/services/']

const BARREL = new URL('../../../../src/index.ts', import.meta.url)

/** Collect the module specifiers of every static import/export-from statement,
 *  ignoring comments (the barrel documents the forbidden paths in prose). */
function importSpecifiers(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  const specs: string[] = []
  const fromRe = /\b(?:import|export)\b[^;]*?\bfrom\s*['"]([^'"]+)['"]/g
  const sideRe = /\bimport\s+['"]([^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = fromRe.exec(code)) !== null) specs.push(match[1]!)
  while ((match = sideRe.exec(code)) !== null) specs.push(match[1]!)
  return specs
}

/** Walk the eager static-import graph from `entry`, following only relative
 *  (`./`, `../`) specifiers (`.js` resolves to the `.ts` on disk), and return
 *  the absolute path + specifiers of every reachable file. */
function eagerGraph(entry: URL): Array<{ path: string; specs: string[] }> {
  const seen = new Set<string>()
  const out: Array<{ path: string; specs: string[] }> = []
  const queue = [fileURLToPath(entry)]
  while (queue.length > 0) {
    const path = queue.shift()!
    if (seen.has(path)) continue
    seen.add(path)
    if (!existsSync(path)) continue
    const specs = importSpecifiers(readFileSync(path, 'utf8'))
    out.push({ path, specs })
    for (const spec of specs) {
      if (spec.startsWith('./') || spec.startsWith('../')) {
        const tsSpec = spec.replace(/\.js$/, '.ts')
        queue.push(fileURLToPath(new URL(tsSpec, pathToFileURL(path))))
      }
    }
  }
  return out
}

test.group('satellite-test-kit boot safety', () => {
  test('importing the main barrel does not require a booted app', async ({ assert }) => {
    const mod = await import('../../../../src/index.js')
    // Importing the whole eager graph succeeds with no Ignitor. If any module in
    // it ever adds an eager import of a service that throws pre-boot, this throws.
    assert.isFunction(mod.runIntegrationSuite)
  })

  test('no file in the eager import graph statically imports an app-dependent service', ({
    assert,
  }) => {
    const graph = eagerGraph(BARREL)

    // Guards the guard: the walk reached past the entry and the parser actually
    // sees imports, so neither a broken walk nor a broken regex can make the
    // check below vacuously pass.
    assert.isAbove(graph.length, 1)
    assert.include(
      graph.flatMap((file) => file.specs),
      '@adonisjs/core'
    )

    for (const { path, specs } of graph) {
      for (const spec of specs) {
        for (const forbidden of FORBIDDEN) {
          assert.isFalse(
            spec.startsWith(forbidden),
            `${path} statically imports "${spec}", which is only safe after the app boots. ` +
              `It is reachable from the eager barrel, so it would break pre-boot import. Move it ` +
              `behind the lazy import('./bootstrap.js') or onto the /testing subpath.`
          )
        }
      }
    }
  })
})

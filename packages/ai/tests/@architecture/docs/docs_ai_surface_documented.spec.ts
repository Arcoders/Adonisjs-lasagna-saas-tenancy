import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Docs-integrity for the AI satellite's TOOL surface (WS-AI-11).
 *
 * Core's `config_documented.spec.ts` walks TOP-LEVEL config keys, so it sees
 * `config.ai` and stops there. Everything under `config.ai.tools` is invisible to it:
 * a new bound, a new hook, or a renamed option could ship undocumented and every gate
 * would stay green. This closes that hole for the nested block, and pins the public
 * `./tools` authoring exports the guide teaches, against the guide itself.
 *
 * Files only (no Ignitor, no DB), so it belongs in the architectural tier.
 */

const PKG_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const TOOLS_DOC = REPO_ROOT + 'docs/guides/satellites/ai-tools.md'
const SECURITY_DOC = REPO_ROOT + 'docs/guides/satellites/ai-security.md'
const DEFINE_CONFIG = PKG_ROOT + 'src/define_config.ts'
const TOOLS_SURFACE = PKG_ROOT + 'src/tools.ts'
const PACKAGE_JSON = PKG_ROOT + 'package.json'

const read = (path: string) => readFileSync(path, 'utf8')

/** Top-level property names of an `export interface <name> { ... }`, brace-matched. */
function interfaceKeys(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name}`)
  if (start === -1) return []
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  const keys: string[] = []
  let d = 0
  for (const line of body.split('\n')) {
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    const m = d === 0 ? line.match(/^\s*(\w+)\??\s*:/) : null
    if (m) keys.push(m[1]!)
    d += opens - closes
  }
  return keys
}

/** Exported function names from the public `./tools` surface. */
function exportedFunctions(source: string): string[] {
  return [...source.matchAll(/^export function (\w+)/gm)].map((m) => m[1]!)
}

test.group('Docs integrity: AI tools surface', () => {
  test('every config.ai.tools option is documented on the AI tools page', ({ assert }) => {
    const page = read(TOOLS_DOC)
    const keys = interfaceKeys(read(DEFINE_CONFIG), 'AIToolsConfig')

    // Sanity: if the parse silently returned [], the filter below would pass on an
    // empty set and this spec would guard nothing.
    assert.includeMembers(
      keys,
      ['registry', 'resolveTools', 'authorizeTool', 'actionTools', 'maxRounds'],
      'the AIToolsConfig interface parse should surface its known options'
    )

    const undocumented = keys.filter((key) => !page.includes(key))
    assert.deepEqual(
      undocumented,
      [],
      `These config.ai.tools options are declared but not documented in ai-tools.md ` +
        `(the top-level config_documented spec cannot see nested keys): ${undocumented.join(', ')}`
    )
  })

  test('every public ./tools authoring helper is documented', ({ assert }) => {
    const page = read(TOOLS_DOC)
    const helpers = exportedFunctions(read(TOOLS_SURFACE))
    assert.includeMembers(helpers, ['readOnlyTool'], 'the ./tools surface should export helpers')

    // `defineTool` / `defineAiTools` are type-inference identities a host may never
    // name; what must be documented is the path a reader is told to take. Assert the
    // ergonomic entry point and the import path explicitly rather than every symbol.
    assert.include(page, 'readOnlyTool', 'the minimal authoring path must be documented')
    assert.include(
      page,
      '@adonisjs-lasagna/ai/tools',
      'the guide must name the real import path for the authoring surface'
    )
  })

  test('the ./tools subpath is a real export, not just a documented one', ({ assert }) => {
    // The guide tells hosts to import from `@adonisjs-lasagna/ai/tools`. Both halves
    // of the export map must carry it: `exports` for runtime, `typesVersions` for the
    // declarations TypeScript resolves separately.
    const pkg = JSON.parse(read(PACKAGE_JSON)) as {
      exports?: Record<string, unknown>
      typesVersions?: Record<string, Record<string, string[]>>
    }
    // `Object.hasOwn`, not `assert.property`: chai reads a dot in the key as a nested
    // path, so `property(exports, './tools')` looks for `exports['']['/tools']` and
    // fails on an export map that is perfectly correct.
    assert.isTrue(
      Object.hasOwn(pkg.exports ?? {}, './tools'),
      'package.json exports must expose ./tools'
    )
    assert.isTrue(
      Object.hasOwn(pkg.typesVersions?.['*'] ?? {}, 'tools'),
      'package.json typesVersions must expose tools (TypeScript resolves declarations separately)'
    )
  })

  test('the tool error codes a host handles are documented', ({ assert }) => {
    // A host writing a client against the stream needs the codes by name: these are
    // what arrive as an in-band `event: error`, or as a pre-flight status. The Phase 3a
    // action-confirmation codes are included so the mutating-tool surface cannot drift
    // back to being undocumented once it shipped.
    const page = read(TOOLS_DOC)
    for (const code of [
      'tool_denied',
      'tool_action_disabled',
      'tool_budget_exhausted',
      'tool_confirmation_required',
      'tool_confirmation_invalid',
      'tool_action_unavailable',
    ]) {
      assert.include(page, code, `the guide must document the ${code} refusal`)
    }
  })

  test('the security page reflects that tools shipped, not that they are post-1.0', ({
    assert,
  }) => {
    // The anti-drift that matters most: a threat model claiming a surface does not
    // exist, after it shipped, is worse than no threat model. Vector #12 / I7 / LLM06
    // must no longer be described as unimplemented.
    const page = read(SECURITY_DOC)
    assert.notMatch(
      page,
      /Tools ship post-1\.0/i,
      'vector #12 still claims tools are post-1.0, but WS-AI-11 shipped'
    )
    assert.notMatch(
      page,
      /I7 is fixed but unimplemented/i,
      'the I7 row still claims the invariant is unimplemented'
    )
    assert.notMatch(
      page,
      /Post-1\.0 \(unimplemented\)/i,
      'the invariants table still marks I7 as unimplemented'
    )
    // And it must point at the guide that now teaches the surface.
    assert.include(page, '/guides/satellites/ai-tools')
  })
})

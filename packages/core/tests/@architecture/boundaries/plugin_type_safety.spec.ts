import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * E1 rigor guard for the `/plugin` public surface. The plan wants this surface
 * "a prueba de balas — cero any, cero !". Enforcement has two clean, per-file
 * legs (the compiler-flag leg — a scoped tsconfig with exactOptionalPropertyTypes
 * / noImplicitOverride — was dropped: those flags leak into transitively-imported
 * shared files and conflict with the repo's exception conventions):
 *
 *   1. an eslint override in eslint.config.js sets `no-explicit-any` +
 *      `no-non-null-assertion` to error for exactly these files, and
 *   2. THIS spec is the lexical backstop that runs in the unit gate (eslint is a
 *      separate gate), and pins the file list so a new plugin module cannot
 *      silently escape either leg.
 *
 * The single source of the surface is {@link PLUGIN_SURFACE_FILES}; a new plugin
 * module must be added here (and to the eslint override, which this spec checks).
 */

const PLUGIN_SURFACE_FILES = [
  'src/sdk/plugin.ts',
  'src/sdk/define_plugin.ts',
  'src/sdk/builders.ts',
  'src/sdk/brands.ts',
  'src/sdk/assert_never.ts',
  'src/sdk/capabilities.ts',
  'src/sdk/plugin_api_version.ts',
  'src/services/authorizer_registry.ts',
  'src/services/tenant_middleware_registry.ts',
  'src/services/capability_registry.ts',
  'src/exceptions/plugin_exception.ts',
  'src/exceptions/plugin_authorizer_exception.ts',
  'src/exceptions/plugin_boot_exception.ts',
  'src/exceptions/plugin_middleware_exception.ts',
  'src/exceptions/request_macro_collision_exception.ts',
  'src/exceptions/capability_collision_exception.ts',
] as const

const CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))

// Bans `any` in every type position that reaches this surface: `: any`,
// `as any`, `<any`, `any[]`, `Array<any`, `Record<…, any`. The one sanctioned
// assertion on this surface is `as Branded<B>` in brands.ts (a controlled brand
// mint, NOT `any`), which this does not match.
const ANY_USAGE =
  /(:\s*any\b|\bas\s+any\b|<\s*any\b|\bany\s*\[\]|\bArray\s*<\s*any\b|\bRecord\s*<[^>]*,\s*any\b)/

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

test.group('Architectural: /plugin surface type safety (E1)', () => {
  test('every listed plugin-surface file exists', ({ assert }) => {
    for (const rel of PLUGIN_SURFACE_FILES) {
      assert.isTrue(existsSync(CORE_ROOT + rel), `missing plugin-surface file: ${rel}`)
    }
  })

  test('no `any` in the /plugin surface', ({ assert }) => {
    const violations: string[] = []
    for (const rel of PLUGIN_SURFACE_FILES) {
      const lines = readFileSync(CORE_ROOT + rel, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (isComment(line)) return
        if (ANY_USAGE.test(line)) violations.push(`${rel}:${i + 1} — ${line.trim().slice(0, 100)}`)
      })
    }
    assert.deepEqual(
      violations,
      [],
      `\`any\` found on the /plugin surface (use \`unknown\` + a type predicate, ` +
        `or a branded type):\n${violations.join('\n')}`
    )
  })

  test('the eslint override covers every plugin-surface file (no drift)', ({ assert }) => {
    const eslintSrc = readFileSync(REPO_ROOT + 'eslint.config.js', 'utf8')
    const missing = PLUGIN_SURFACE_FILES.filter(
      (rel) => !eslintSrc.includes(`'packages/core/${rel}'`)
    )
    assert.deepEqual(
      missing,
      [],
      `plugin-surface file(s) not listed in the eslint E1 override block ` +
        `(add them so no-explicit-any / no-non-null-assertion apply):\n${missing.join('\n')}`
    )
  })

  test('the `any` detector flags the patterns it must (controls)', ({ assert }) => {
    for (const s of [
      'const x: any = 1',
      'y as any',
      'Array<any>',
      'foo: any[]',
      'Record<string, any>',
    ]) {
      assert.isTrue(ANY_USAGE.test(s), `should flag: ${s}`)
    }
    for (const s of [
      'const x: unknown = 1',
      'raw as Branded<B>',
      'readonly any[]'.replace('any', 'string'),
    ]) {
      assert.isFalse(ANY_USAGE.test(s), `should NOT flag: ${s}`)
    }
  })
})

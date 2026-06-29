import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Lucid models rely on `experimentalDecorators` + `emitDecoratorMetadata` to
 * reflect `@column` metadata at runtime. Those flags live once in the root
 * tsconfig.json and every package inherits them through its `extends` chain.
 * This guard walks each package's effective config the way tsc does and proves
 * both flags still resolve to `true`, so a broken `extends` link (or a dropped
 * root flag) fails loudly here instead of silently shipping a build whose
 * compiled models have no decorator metadata.
 */

const repoRoot = fileURLToPath(new URL('../../../../../', import.meta.url))

/** Strip line and block comments so a JSONC tsconfig still parses. */
function parseJsonc(text: string): Record<string, any> {
  const noComments = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  return JSON.parse(noComments)
}

/** Merge compilerOptions down the `extends` chain (root first, leaf wins). */
function effectiveCompilerOptions(configPath: string): Record<string, any> {
  const config = parseJsonc(readFileSync(configPath, 'utf8'))
  const own = config.compilerOptions ?? {}
  if (!config.extends) return own
  const parentPath = resolve(dirname(configPath), config.extends)
  return { ...effectiveCompilerOptions(parentPath), ...own }
}

// Configs that compile (or typecheck) Lucid models and MUST resolve both flags.
// Includes the tsconfig.build.json variants — those are what `npm run build`
// actually invokes, and they extend the PACKAGE config, not root directly.
const MUST_HAVE_DECORATORS = [
  'packages/core/tsconfig.json',
  'packages/core/tsconfig.build.json',
  'packages/billing/tsconfig.json',
  'packages/reporting/tsconfig.json',
  'packages/sso/tsconfig.json',
  'packages/admin/tsconfig.json',
  'packages/backup/tsconfig.json',
  'packages/satellite-template/tsconfig.json',
  'packages/satellite-test-kit/tsconfig.json',
  // Standalone (do NOT extend root) — they keep their own copy of the flags.
  'examples/api/tsconfig.json',
  'benchmarks/tsconfig.json',
]

test.group('tsconfig decorator flags resolve through inheritance', () => {
  for (const rel of MUST_HAVE_DECORATORS) {
    test(`${rel} enables experimentalDecorators + emitDecoratorMetadata`, ({ assert }) => {
      const opts = effectiveCompilerOptions(resolve(repoRoot, rel))
      assert.isTrue(
        opts.experimentalDecorators === true,
        `${rel}: experimentalDecorators must resolve to true (check the extends chain)`
      )
      assert.isTrue(
        opts.emitDecoratorMetadata === true,
        `${rel}: emitDecoratorMetadata must resolve to true (check the extends chain)`
      )
    })
  }
})

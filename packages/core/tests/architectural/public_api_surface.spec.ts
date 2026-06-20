import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT_INDEX = fileURLToPath(new URL('../../src/index.ts', import.meta.url))
const SERVICES_INDEX = fileURLToPath(new URL('../../src/services/index.ts', import.meta.url))

/**
 * Guards the public API contract documented at the top of src/index.ts:
 *
 *  1. Every name the root barrel re-exports from `./services` must actually be
 *     exported by `./services`. The two lists are maintained by hand, so this
 *     catches a rename or removal on one side before it ships as a broken import.
 *  2. The root must never re-export the explicitly-unstable `./internal` surface.
 *  3. The concrete built-in driver/resolver implementations stay on `/services`
 *     only; re-adding them to the root would undo the surface curation.
 *
 * These read source rather than importing the barrels: importing the root barrel
 * outside an Ignitor pulls @adonisjs/core's eager logger, whose top-level
 * `await app.booted()` throws. The raw-SQL architectural spec reads source for
 * the same reason.
 */

// `[^}]*` (not `[\s\S]*?`) keeps each capture inside a single export block —
// these barrels have no nested braces, and a lazy dot-all would backtrack across
// `}` boundaries and swallow every block up to the anchor.

/** Pull the exported identifiers out of every `export { ... }` / `export type { ... }` block. */
function exportedNames(source: string): Set<string> {
  return parseBlocks(source, /export\s+(?:type\s+)?\{([^}]*)\}/g)
}

/** Just the names the root re-exports from `./services/index.js`. */
function servicesReexports(source: string): Set<string> {
  return parseBlocks(
    source,
    /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]\.\/services\/index\.js['"]/g
  )
}

function parseBlocks(source: string, blockRe: RegExp): Set<string> {
  const names = new Set<string>()
  let m: RegExpExecArray | null
  while ((m = blockRe.exec(source)) !== null) {
    for (const raw of m[1].split(',')) {
      const entry = raw.trim()
      if (!entry) continue
      // `A as B` and `default as B` both export the name B.
      const exported = entry.includes(' as ') ? entry.split(' as ').pop()!.trim() : entry
      if (exported) names.add(exported)
    }
  }
  return names
}

// Concrete built-ins that were intentionally pulled off the root and now live on
// `/services` only. Selected by config string / registry, never imported by apps.
const TRIMMED_FROM_ROOT = [
  'SchemaPgDriver',
  'DatabasePgDriver',
  'RowScopePgDriver',
  'SqliteMemoryDriver',
  'HeaderResolver',
  'SubdomainResolver',
  'PathResolver',
  'DomainOrSubdomainResolver',
  'RequestDataResolver',
  'ResolverHit',
  'builtInResolvers',
]

test.group('Architectural: public API surface', () => {
  test('root barrel does not drift from the ./services surface it re-exports', ({ assert }) => {
    const reexported = servicesReexports(readFileSync(ROOT_INDEX, 'utf8'))
    const serviceExports = exportedNames(readFileSync(SERVICES_INDEX, 'utf8'))

    // Sanity check the parser actually found the re-export block.
    assert.isAbove(reexported.size, 0, 'expected the root to re-export names from ./services')

    const missing = [...reexported].filter((name) => !serviceExports.has(name))
    assert.deepEqual(
      missing,
      [],
      `The root barrel re-exports name(s) that './services/index.ts' no longer exports: ` +
        `${missing.join(', ')}. Update one side so the two stay in sync.`
    )
  })

  test('root barrel never re-exports the unstable ./internal surface', ({ assert }) => {
    assert.notMatch(
      readFileSync(ROOT_INDEX, 'utf8'),
      /from\s+['"]\.\/internal(\.js)?['"]/,
      "src/index.ts must not re-export from './internal' — that subpath is explicitly unstable."
    )
  })

  test('built-in driver/resolver implementations stay off the root barrel', ({ assert }) => {
    const rootExports = exportedNames(readFileSync(ROOT_INDEX, 'utf8'))
    const leaked = TRIMMED_FROM_ROOT.filter((name) => rootExports.has(name))
    assert.deepEqual(
      leaked,
      [],
      `These built-in implementations belong on '/services' only, not the root barrel: ` +
        `${leaked.join(', ')}. Apps pick a driver via config (isolation.driver) and resolvers ` +
        `via TenantResolverRegistry, so they never import these classes.`
    )
  })
})

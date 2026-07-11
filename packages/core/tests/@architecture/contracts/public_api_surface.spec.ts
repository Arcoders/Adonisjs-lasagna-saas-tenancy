import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const ROOT_INDEX = fileURLToPath(new URL('../../../src/index.ts', import.meta.url))
const SERVICES_INDEX = fileURLToPath(new URL('../../../src/services/index.ts', import.meta.url))
const CONFIG_MODULE = fileURLToPath(new URL('../../../src/config.ts', import.meta.url))
const PACKAGE_JSON = fileURLToPath(new URL('../../../package.json', import.meta.url))

/** Subpaths removed from `exports` in the pre-release surface freeze. */
const DE_LISTED_SUBPATHS = [
  './crypto',
  './worm-ledger',
  './adapters',
  './helpers',
  './extensions/request',
]

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

// `[^}]*` (not `[\s\S]*?`) keeps each capture inside a single export block:
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
    for (const raw of m[1]!.split(',')) {
      const entry = raw.trim()
      if (!entry) continue
      // `A as B` and `default as B` both export the name B.
      const exported = entry.includes(' as ') ? entry.split(' as ').pop()!.trim() : entry
      if (exported) names.add(exported)
    }
  }
  return names
}

// Plumbing that was intentionally pulled off the root and now lives on a
// subpath only. Re-adding any of these would undo the surface freeze.
const TRIMMED_FROM_ROOT = [
  // Concrete built-in drivers/resolvers, selected by config string / registry
  // (`isolation.driver`, the resolver chain), never imported by an app. `/services`.
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
  // The extension registries: an app registers through config + declarative
  // hooks, not by reaching for the registry. `/services`.
  'HookRegistry',
  'BootstrapperRegistry',
  'IsolationDriverRegistry',
  'TenantResolverRegistry',
  // Bootstrapper helpers, one per optional integration. `/services`.
  'cacheBootstrapper',
  'driveBootstrapper',
  'mailBootstrapper',
  'sessionBootstrapper',
  'transmitBootstrapper',
  'tenantCache',
  'tenantDisk',
  'tenantMailer',
  'tenantSession',
  'tenantBroadcast',
  'tenantLogger',
  'configuredScopeColumn',
  'getActiveDriver',
  // The six opt-in satellite models. `/models/satellites`.
  'TenantAuditLog',
  'TenantFeatureFlag',
  'TenantWebhook',
  'TenantWebhookDelivery',
  'TenantBranding',
  'TenantMetric',
  // The DNS-pinned egress helper. `/safe-fetch`.
  'safeFetch',
  'SafeFetchError',
  'TRUSTED_FETCH_HOSTS',
  // The AEAD envelope primitives and the SSRF URL guards. A host composes them
  // only through `readSecret` / `writeSecret`, which stay on the root. `/internal`.
  'encrypt',
  'decrypt',
  'decryptStrict',
  'decryptWithAppKey',
  'isEncrypted',
  'sealV2WithKey',
  'openV2WithKey',
  'validateExternalHttpsUrl',
  'validateResolvedHostIsPublic',
]

/**
 * `configure` is what `node ace configure @adonisjs-lasagna/saas-tenancy` reads
 * off the package's main entry (`app.import(pkg)` reads `packageExports.configure`).
 * Drop it from the barrel and the very first command in the quickstart becomes a
 * silent no-op that still exits 0, which is exactly how it shipped once before.
 */
const MUST_STAY_ON_ROOT = ['configure']

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

  test('the configure hook stays on the root barrel', ({ assert }) => {
    const rootExports = exportedNames(readFileSync(ROOT_INDEX, 'utf8'))
    const missing = MUST_STAY_ON_ROOT.filter((name) => !rootExports.has(name))
    assert.deepEqual(
      missing,
      [],
      `src/index.ts must keep exporting ${missing.join(', ')}. ` +
        `'node ace configure' does app.import(pkg) and reads packageExports.configure; ` +
        `without it the command warns and publishes nothing while still exiting 0.`
    )
  })

  test('the de-listed subpaths stay off the exports map', ({ assert }) => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
    const relisted = DE_LISTED_SUBPATHS.filter((subpath) => subpath in pkg.exports)
    assert.deepEqual(
      relisted,
      [],
      `${relisted.join(', ')} were de-listed in the surface freeze. Every symbol they carried ` +
        `is reachable from the root barrel or '/internal'; re-listing one re-adds a public ` +
        `promise. See docs/reference/stability.md.`
    )
  })

  test('exports and typesVersions describe the same subpaths', ({ assert }) => {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'))
    // TypeScript resolves declaration files through `typesVersions`, independently
    // of the runtime `exports` map. Update one and forget the other and the subpath
    // either resolves at runtime with no types, or typechecks and then throws
    // ERR_PACKAGE_PATH_NOT_EXPORTED at import.
    const runtime = Object.keys(pkg.exports)
      .filter((key) => key !== '.')
      .map((key) => key.slice(2))
      .sort()
    const types = Object.keys(pkg.typesVersions['*']).sort()
    assert.deepEqual(
      runtime,
      types,
      `package.json 'exports' and 'typesVersions' drifted. Both maps must list the same subpaths.`
    )
  })

  test('config.ts exposes no test-only seam on the public /config surface', ({ assert }) => {
    // `/config` is public and six satellites import it, so a `__*ForTests` export
    // here would be a permanent public promise. The reset lives on `/testing`
    // (src/testing/config_reset.ts) and reaches the singleton through src/config_store.ts.
    assert.notMatch(
      readFileSync(CONFIG_MODULE, 'utf8'),
      /export\s+(?:async\s+)?function\s+__\w+ForTests/,
      "src/config.ts must not export a __*ForTests seam — '/config' is a public subpath. " +
        'Put the seam on the /testing barrel instead.'
    )
  })
})

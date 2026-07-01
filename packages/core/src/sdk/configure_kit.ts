import { createRequire } from 'node:module'
import { readFile, readdir, rename } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { readSatelliteManifest } from './manifest.js'
import type { DiscoveredSatellite, SatelliteManifest } from './manifest.js'

/**
 * Configure-time toolkit shared by core's own `configure.ts` and by a
 * satellite package's own `adonisjs.configure` hook. Keeping the publish /
 * discovery logic here (a built, exported module) means both entry points run
 * the *same* code, so the core-orchestrated `--with=@pkg` flow and the
 * per-package `node ace configure @pkg` flow can never drift.
 *
 * This module is intentionally free of any `app.booted`-touching import (no
 * logger, no `/services` barrel) so it loads in a bare configure context and in
 * unit tests alike. Callers pass their own logger via `onWarn` / `printSatelliteManifest`.
 */

/** Minimal structural view of the AdonisJS codemods object we use. */
export interface CodemodsLike {
  makeUsingStub(
    stubsRoot: string,
    stubPath: string,
    data: Record<string, unknown>
  ): Promise<unknown>
  updateRcFile(
    callback: (rcFile: { addProvider(p: string): unknown; addCommand(c: string): unknown }) => void
  ): Promise<unknown>
}

/** Minimal logger view (matches the ace command logger). */
export interface LoggerLike {
  log(message: string): void
  info(message: string): void
  warning(message: string): void
}

/**
 * Split resolved stub names into the ones not yet published and the ones already
 * present in the host's migrations directory. A stub counts as already published
 * when an existing file matches `<digits>_<stub>.ts` — migration stubs are
 * emitted as `${Date.now()}_<stub>.ts`, so the timestamp prefix is always new
 * and the codemod's own "file exists" skip never fires.
 *
 * This is what makes `configure` safe to re-run: a second pass skips migrations
 * it already wrote instead of emitting timestamped duplicates that would later
 * collide on `migration:run`.
 */
export function filterAlreadyPublished(
  stubs: string[],
  existing: string[]
): { toPublish: string[]; skipped: string[] } {
  const toPublish: string[] = []
  const skipped: string[] = []
  for (const stub of stubs) {
    const escaped = stub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^\\d+_${escaped}\\.ts$`)
    if (existing.some((file) => re.test(file))) skipped.push(stub)
    else toPublish.push(stub)
  }
  return { toPublish, skipped }
}

/**
 * Read the basenames of every file under the host's migrations directory
 * (recursively, so hosts that organise migrations into subfolders are still
 * covered). Best-effort: a host that hasn't created the directory yet is treated
 * as having no migrations. Feeds `filterAlreadyPublished`.
 */
export async function listExistingMigrations(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir, { recursive: true })
    return entries.map((entry) => entry.split(/[\\/]/).pop() ?? entry)
  } catch {
    return []
  }
}

/**
 * Resolve a dependency's package root (the dir holding its package.json) from
 * the host app. Tries the conventional `<dep>/package.json` subpath first, then
 * falls back to resolving the package entry and walking up — needed because a
 * package with an `exports` map may not expose `./package.json`.
 */
function resolvePackageRoot(require: NodeRequire, dep: string): string | null {
  try {
    return dirname(require.resolve(`${dep}/package.json`))
  } catch {
    /* fall through */
  }
  try {
    let dir = dirname(require.resolve(dep))
    for (let i = 0; i < 16; i++) {
      const candidate = join(dir, 'package.json')
      if (existsSync(candidate)) {
        try {
          const name = JSON.parse(require('node:fs').readFileSync(candidate, 'utf8')).name
          if (name === dep) return dir
        } catch {
          /* keep walking */
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    /* not resolvable */
  }
  return null
}

/**
 * Discover every installed package that declares a `lasagnaSatellite` manifest.
 * Scans the host app's direct `dependencies` + `devDependencies` (predictable
 * scope; satellites are direct installs). Never imports a satellite — it only
 * reads `package.json` files. Best-effort: an unresolvable / unreadable dep is
 * skipped silently.
 */
export async function discoverSatellites(
  hostRoot: string,
  onWarn: (message: string) => void = () => {}
): Promise<DiscoveredSatellite[]> {
  let hostPkg: Record<string, unknown>
  try {
    hostPkg = JSON.parse(await readFile(join(hostRoot, 'package.json'), 'utf8'))
  } catch {
    return []
  }

  const deps = {
    ...(hostPkg.dependencies as Record<string, string> | undefined),
    ...(hostPkg.devDependencies as Record<string, string> | undefined),
  }
  const names = Object.keys(deps ?? {})
  if (names.length === 0) return []

  const require = createRequire(join(hostRoot, 'package.json'))
  const found: DiscoveredSatellite[] = []

  for (const dep of names) {
    const root = resolvePackageRoot(require, dep)
    if (!root) continue
    let pkgJson: unknown
    try {
      pkgJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    } catch {
      continue
    }
    const manifest = readSatelliteManifest(pkgJson, onWarn)
    if (manifest) {
      const version =
        pkgJson && typeof (pkgJson as Record<string, unknown>).version === 'string'
          ? ((pkgJson as Record<string, unknown>).version as string)
          : undefined
      found.push({ packageName: dep, root, version, manifest })
    }
  }

  return found
}

/**
 * The per-tenant migration directories (SEAM-2) contributed by discovered
 * satellites, as paths RELATIVE to the host root and forward-slashed.
 *
 * `tenant:migrate` folds these into `MigrateOptions.extraMigrationPaths`, and
 * Lucid resolves each migration directory with `new URL(dir, app.appRoot)`. An
 * ABSOLUTE path breaks that on Windows (the drive letter `C:` parses as a URL
 * scheme, so `fileURLToPath` throws), so we always emit a root-relative,
 * forward-slashed path: it resolves correctly on every OS and keeps the migration
 * ledger name stable across platforms. A satellite that declares no
 * `perTenantMigrations` contributes nothing.
 */
export function satelliteMigrationDirs(
  hostRoot: string,
  satellites: DiscoveredSatellite[]
): string[] {
  return satellites
    .filter((s) => s.manifest.perTenantMigrations)
    .map((s) =>
      relative(hostRoot, join(s.root, s.manifest.perTenantMigrations as string)).replace(/\\/g, '/')
    )
}

/** Build a lookup of `packageName` and every `alias` → DiscoveredSatellite. */
export function indexSatellites(
  satellites: DiscoveredSatellite[]
): Map<string, DiscoveredSatellite> {
  const index = new Map<string, DiscoveredSatellite>()
  for (const sat of satellites) {
    index.set(sat.packageName, sat)
    for (const alias of sat.manifest.aliases ?? []) {
      if (!index.has(alias)) index.set(alias, sat)
    }
  }
  return index
}

/**
 * A filesystem-safe slug for a package name, used to namespace the migrations a
 * satellite publishes (`@adonisjs-lasagna/billing` → `adonisjs_lasagna_billing`).
 */
export function migrationSlug(packageName: string): string {
  return packageName
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase()
}

/**
 * Whether a stub is already published. Recognizes this satellite's namespaced
 * form `<ts>_<slug>__<stub>.ts` (unambiguously ours) and the legacy
 * un-namespaced `<ts>_<stub>.ts` that a pre-namespacing install wrote. A
 * DIFFERENT satellite's namespaced file with the same basename is NOT a match.
 *
 * The legacy form carries no package info, so it is matched best-effort: it
 * keeps a re-run on an existing install from duplicating that satellite's own
 * migration. The (rare) cost is that if a DIFFERENT satellite later ships a stub
 * with the same basename while a legacy file already exists for it, the newcomer
 * is treated as already-published. Name your migration's TABLE for your package
 * (the documented convention) so this can never matter in practice; new installs
 * always namespace, so the only exposure is the pre-namespacing upgrade window.
 */
function isStubPublished(stub: string, existing: string[], slug: string): boolean {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`^\\d+_(?:${esc(slug)}__)?${esc(stub)}\\.ts$`)
  return existing.some((file) => re.test(file))
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

/**
 * Namespace the migration files a satellite just emitted: rename each newly
 * created `<ts>_<basename>.ts` to `<ts>_<slug>__<basename>.ts`. The migration
 * destination lives inside each stub's `exports({ to })` header, so the toolkit
 * takes ownership of the final filename HERE — that is what stops two satellites
 * that ship a stub with the same basename from colliding (the second used to be
 * silently skipped, so its table was never created). Skips a rename whose target
 * already exists so we never clobber a file.
 */
async function namespaceNewMigrations(
  dir: string,
  before: Set<string>,
  slug: string
): Promise<void> {
  const present = new Set(await safeReaddir(dir))
  for (const file of present) {
    if (before.has(file)) continue
    const m = file.match(/^(\d+)_(.+)\.ts$/)
    if (!m) continue
    if (m[2].startsWith(`${slug}__`)) continue // already namespaced
    const target = `${m[1]}_${slug}__${m[2]}.ts`
    if (present.has(target)) continue // never clobber an existing file
    await rename(join(dir, file), join(dir, target))
  }
}

/**
 * Publish a satellite's own migration stubs into the host. Reuses the exact
 * `codemods.makeUsingStub` path core uses for its own stubs, with the satellite
 * package root as `stubsRoot`.
 *
 * Only `.stub` files are published. Every emitted file is namespaced by package
 * (`<ts>_<slug>__<stub>.ts`) so two satellites that ship the same stub basename
 * no longer collide (before this, the second was silently skipped and its table
 * was never created). Namespacing is intrinsic, not opt-in: `hostMigrationsDir`
 * — the host's migrations directory, the same dir each stub's `exports({ to })`
 * targets — is required, and the toolkit owns the final filename.
 *
 * Idempotent: a stub already present (under either the namespaced form or the
 * legacy un-namespaced `<ts>_<stub>.ts` an older install wrote) is skipped, so a
 * re-run never writes a duplicate. The already-published set is read from
 * `hostMigrationsDir`, so the caller cannot accidentally pass a stale or
 * mismatched list.
 */
export async function publishSatellite(
  codemods: CodemodsLike,
  satellite: DiscoveredSatellite,
  hostMigrationsDir: string
): Promise<{ published: string[]; skipped: string[] }> {
  const { root, manifest } = satellite
  if (!manifest.migrations) return { published: [], skipped: [] }

  const stubsDir = join(root, manifest.migrations)
  const rel = relative(root, stubsDir)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `[lasagna] ${satellite.packageName}: migrations dir escapes the package root — refusing`
    )
  }

  let files: string[]
  try {
    files = (await readdir(stubsDir)).sort()
  } catch {
    return { published: [], skipped: [] }
  }

  const slug = migrationSlug(satellite.packageName)
  const existing = await listExistingMigrations(hostMigrationsDir)
  const stubNames = files.filter((f) => f.endsWith('.stub')).map((f) => f.replace(/\.stub$/, ''))
  const toPublish: string[] = []
  const skipped: string[] = []
  for (const name of stubNames) {
    if (isStubPublished(name, existing, slug)) skipped.push(name)
    else toPublish.push(name)
  }
  if (toPublish.length === 0) return { published: [], skipped }

  // Snapshot before publishing so we can identify (and namespace) exactly the
  // files these stubs emit into the host migrations dir.
  const before = new Set(await safeReaddir(hostMigrationsDir))

  for (const name of toPublish) {
    await codemods.makeUsingStub(root, join(manifest.migrations, `${name}.stub`), {})
  }

  await namespaceNewMigrations(hostMigrationsDir, before, slug)

  return { published: toPublish, skipped }
}

/**
 * Register a satellite's provider + commands in `adonisrc.ts`. The only place we
 * patch the host's rc file (the framework's sanctioned codemod); the host's
 * `config/multitenancy.ts` is never patched — we only print a snippet for it.
 * `addProvider` / `addCommand` are no-ops if the entry already exists, so this
 * is re-run safe.
 */
export async function registerSatelliteInRcFile(
  codemods: CodemodsLike,
  manifest: SatelliteManifest
): Promise<void> {
  if (!manifest.provider && !manifest.commands) return
  await codemods.updateRcFile((rcFile) => {
    if (manifest.provider) rcFile.addProvider(manifest.provider)
    if (manifest.commands) rcFile.addCommand(manifest.commands)
  })
}

/**
 * Print the install reminder for a satellite: peer installs, required env, the
 * `requires` prerequisite, and the config snippet to paste. The generalization
 * of core's old `postPublishBilling` / `postPublishConfigReminders`.
 */
export function printSatelliteManifest(logger: LoggerLike, manifest: SatelliteManifest): void {
  logger.log('')
  logger.log(`— ${manifest.name} satellite — additional setup —`)

  if (manifest.requires && manifest.requires.length > 0) {
    logger.log(
      `Requires core feature(s): ${manifest.requires.join(', ')}. If not already published, run:`
    )
    logger.log(
      `  node ace configure @adonisjs-lasagna/saas-tenancy --with=${manifest.requires.join(',')}`
    )
  }

  if (manifest.install && manifest.install.length > 0) {
    logger.log('Install:')
    for (const line of manifest.install) logger.log(`  ${line}`)
  }

  if (manifest.env && manifest.env.length > 0) {
    logger.log(`Required environment variables: ${manifest.env.join(', ')}`)
  }

  if (manifest.configSnippet) {
    logger.log('Add to config/multitenancy.ts (inside defineConfig({...})):')
    for (const line of manifest.configSnippet.split('\n')) logger.log(`  ${line}`)
  }

  if (manifest.docs) logger.log(`Docs: ${manifest.docs}`)
}

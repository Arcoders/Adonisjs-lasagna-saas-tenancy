import { createRequire } from 'node:module'
import { readFile, readdir } from 'node:fs/promises'
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
    if (manifest) found.push({ packageName: dep, root, manifest })
  }

  return found
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
 * Publish a satellite's own migration stubs into the host. Reuses the exact
 * `codemods.makeUsingStub` path core uses for its own stubs, with the satellite
 * package root as `stubsRoot`. Idempotent via `filterAlreadyPublished`.
 *
 * Only `.stub` files are published — their `{{{ exports({ to:
 * app.migrationsPath(...) }) }}}` header is what emits the host migration with a
 * `${Date.now()}` prefix (and so the idempotency guard). Any other file in the
 * dir is ignored.
 */
export async function publishSatellite(
  codemods: CodemodsLike,
  satellite: DiscoveredSatellite,
  existing: string[]
): Promise<{ published: string[]; skipped: string[] }> {
  const { root, manifest } = satellite
  if (!manifest.migrations) return { published: [], skipped: [] }

  const migrationsDir = join(root, manifest.migrations)
  const rel = relative(root, migrationsDir)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(
      `[lasagna] ${satellite.packageName}: migrations dir escapes the package root — refusing`
    )
  }

  let files: string[]
  try {
    files = (await readdir(migrationsDir)).sort()
  } catch {
    return { published: [], skipped: [] }
  }

  const stubNames = files.filter((f) => f.endsWith('.stub')).map((f) => f.replace(/\.stub$/, ''))
  const { toPublish, skipped } = filterAlreadyPublished(stubNames, existing)
  for (const name of toPublish) {
    await codemods.makeUsingStub(root, join(manifest.migrations, `${name}.stub`), {})
  }

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

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
 * when an existing file matches `<digits>_<stub>.ts`. Migration stubs are
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
 * falls back to resolving the package entry and walking up, needed because a
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
 * scope; satellites are direct installs). Never imports a satellite: it only
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
 * The per-tenant migration directories contributed by discovered
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

/** Build a lookup from `packageName` and every `alias` to its DiscoveredSatellite. */
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
 * One resolved migration relocation: the legacy ledger name (`from`) and the
 * canonical satellite migration ledger name (`to`) it maps to, plus the declaring
 * satellite for attribution. `to` is computed exactly as {@link satelliteMigrationDirs}
 * computes a fold path (`<relative satellite dir>/<migration>`, forward-slashed), so
 * it matches the `adonis_schema.name` Lucid records byte-for-byte.
 */
export interface ResolvedMigrationAlias {
  from: string
  to: string
  /** The declaring satellite's npm package name. */
  ownerPackage: string
  /** The declaring satellite's manifest name (its slug). */
  ownerSlug: string
}

/**
 * Build the fleet-shared, validated migration-alias map from discovered satellites,
 * keyed by the canonical `to` ledger name.
 *
 * Ownership by construction: each `to` is built from the DECLARING satellite's own
 * `perTenantMigrations` dir, so a satellite can only relocate INTO a migration it
 * ships. A satellite that declares aliases but no `perTenantMigrations` owns no
 * target and its aliases are dropped.
 *
 * Fail-closed fleet-wide: ANY structural violation — a duplicate `from` or `to`
 * across the whole fleet, or a chain where one alias's `to` is another's `from` —
 * drops the ENTIRE map (returns empty), so a single malformed or malicious manifest
 * can never drive a bad reconcile. The per-tenant reconcile envelope re-verifies
 * physical existence, structural match, and data-fingerprint equality on top of this,
 * so a mis-declared `from` is bounded to at worst a no-op refusal.
 */
export function buildMigrationAliasMap(
  hostRoot: string,
  satellites: DiscoveredSatellite[],
  onWarn: (message: string) => void = () => {}
): Map<string, ResolvedMigrationAlias> {
  const resolved: ResolvedMigrationAlias[] = []
  for (const sat of satellites) {
    const aliases = sat.manifest.migrationAliases
    if (!aliases || aliases.length === 0) continue
    const dir = sat.manifest.perTenantMigrations
    if (!dir) {
      onWarn(
        `[lasagna] ${sat.packageName}: declares migrationAliases but no perTenantMigrations — ` +
          `dropping its aliases (it owns no target to relocate into)`
      )
      continue
    }
    const relDir = relative(hostRoot, join(sat.root, dir)).replace(/\\/g, '/')
    for (const alias of aliases) {
      const from = alias.from.normalize('NFC')
      const to = `${relDir}/${alias.migration}`.normalize('NFC')
      if (from === to) {
        onWarn(`[lasagna] ${sat.packageName}: migration alias from === to (${from}) — dropping it`)
        continue
      }
      resolved.push({ from, to, ownerPackage: sat.packageName, ownerSlug: sat.manifest.name })
    }
  }

  if (resolved.length === 0) return new Map()

  const froms = new Set<string>()
  const tos = new Set<string>()
  for (const r of resolved) {
    if (froms.has(r.from) || tos.has(r.to)) {
      onWarn(
        `[lasagna] migration-alias collision on ` +
          `${froms.has(r.from) ? `from "${r.from}"` : `to "${r.to}"`} — dropping the ENTIRE ` +
          `alias map fleet-wide (fail-closed)`
      )
      return new Map()
    }
    froms.add(r.from)
    tos.add(r.to)
  }
  // No chain/cycle: a relocation target must never also be a relocation source.
  for (const r of resolved) {
    if (tos.has(r.from) || froms.has(r.to)) {
      onWarn(
        `[lasagna] migration-alias chain detected (a "to" is also a "from") — dropping the ` +
          `ENTIRE alias map fleet-wide (fail-closed)`
      )
      return new Map()
    }
  }

  return new Map(resolved.map((r) => [r.to, r]))
}

/**
 * A filesystem-safe slug for a package name, used to namespace the migrations a
 * satellite publishes (`@adonisjs-lasagna/billing` becomes `adonisjs_lasagna_billing`).
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

/** A migration file as Lucid sees it: `<timestamp>_<name>.ts`, run in filename order. */
const MIGRATION_FILE = /^(\d+)_(.+)\.ts$/

/** Timestamps are zero-padded to this width so string order equals numeric order. */
const TIMESTAMP_WIDTH = 13

/**
 * Snapshot the migration directory's own files (not its subdirectories), for a
 * caller that is about to publish into it and then hand the result to
 * `finalizeNewMigrations`.
 */
export async function snapshotMigrationDir(dir: string): Promise<Set<string>> {
  return new Set(await safeReaddir(dir))
}

/**
 * The migration name a stub publishes, with its optional `NNNN_` publish-order
 * prefix removed. The prefix exists only so `readdir().sort()` inside a package
 * yields the order the migrations must RUN in (a `create` before the `alter`
 * that widens it). It is not part of the migration's identity: it never reaches
 * the host and never enters the already-published key, so adding one to an
 * existing stub does not republish it on an install that already ran it.
 */
export function stubMigrationName(stubFile: string): string {
  return stubFile.replace(/\.stub$/, '').replace(/^\d{4}_/, '')
}

/** The highest `<timestamp>_` prefix among a set of migration filenames. */
function highestTimestamp(files: Iterable<string>): number {
  let highest = 0
  for (const file of files) {
    const m = file.match(MIGRATION_FILE)
    if (m) highest = Math.max(highest, Number(m[1]))
  }
  return highest
}

/**
 * Take ownership of the filenames a publish batch just emitted, and re-stamp them
 * so the order they were published in is the order Lucid runs them in.
 *
 * Every migration stub names its own output `${Date.now()}_<name>.ts`. Two stubs
 * published in the same millisecond therefore tie, and Lucid breaks the tie
 * alphabetically, which is the order the *characters* of the table names happen
 * to fall in, not the order the tables depend on each other. `tenant_webhook_deliveries`
 * sorted ahead of the `tenant_webhooks` its foreign key points at; billing's
 * `add_processing_status_…` sorted ahead of the `create_…` it alters. Both are the
 * same defect: the emitted filename recorded WHEN a stub was rendered, never the
 * order the caller asked for.
 *
 * So the toolkit re-stamps: the i-th name in `order` gets `base + i`, where `base`
 * clears every timestamp already in the directory. Ties become impossible rather
 * than unlikely. Files the batch emitted that `order` does not name keep their
 * relative order and land after it. A rename whose target already exists is skipped,
 * so we never clobber a file.
 *
 * `slug` (a satellite's package slug) additionally namespaces each file as
 * `<ts>_<slug>__<name>.ts`, which is what stops two satellites shipping a stub with
 * the same basename from colliding. Before namespacing, the second was silently
 * skipped and its table was never created. Core publishes its own stubs un-namespaced.
 */
export async function finalizeNewMigrations(
  dir: string,
  before: Set<string>,
  order: string[],
  slug?: string
): Promise<void> {
  const present = await safeReaddir(dir)

  // The files this batch emitted, keyed by migration name. A stub renders its own
  // `exports({ to })` header, so the name is whatever it wrote minus the timestamp.
  const emitted = new Map<string, string>()
  for (const file of present) {
    if (before.has(file)) continue
    const m = file.match(MIGRATION_FILE)
    if (!m) continue
    const written = m[2]!
    const name = slug && written.startsWith(`${slug}__`) ? written.slice(slug.length + 2) : written
    emitted.set(name, file)
  }
  if (emitted.size === 0) return

  const requested = order.filter((name) => emitted.has(name))
  const unrequested = [...emitted.keys()].filter((name) => !order.includes(name)).sort()

  const base = Math.max(Date.now(), highestTimestamp(before) + 1)
  const taken = new Set(present)

  let offset = 0
  for (const name of [...requested, ...unrequested]) {
    const file = emitted.get(name)!
    const stamp = String(base + offset++).padStart(TIMESTAMP_WIDTH, '0')
    const target = `${stamp}_${slug ? `${slug}__` : ''}${name}.ts`
    if (target === file || taken.has(target)) continue
    await rename(join(dir, file), join(dir, target))
    taken.delete(file)
    taken.add(target)
  }
}

/**
 * Publish a satellite's own migration stubs into the host. Reuses the exact
 * `codemods.makeUsingStub` path core uses for its own stubs, with the satellite
 * package root as `stubsRoot`.
 *
 * Only `.stub` files are published, in `readdir().sort()` order. A package whose
 * migrations depend on each other (a `create` that an `alter` later widens, a
 * foreign key pointing at a sibling table) names its stubs with an `NNN_` prefix
 * so that sort IS the dependency order; `finalizeNewMigrations` then seals that
 * order into the emitted timestamps. Every emitted file is namespaced by package
 * (`<ts>_<slug>__<stub>.ts`) so two satellites that ship the same stub basename
 * no longer collide (before this, the second was silently skipped and its table
 * was never created). Namespacing is intrinsic, not opt-in: `hostMigrationsDir`
 * (the host's migrations directory, the same dir each stub's `exports({ to })`
 * targets) is required, and the toolkit owns the final filename.
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
  const stubs = files
    .filter((f) => f.endsWith('.stub'))
    .map((file) => ({ file, name: stubMigrationName(file) }))
  const toPublish: { file: string; name: string }[] = []
  const skipped: string[] = []
  for (const stub of stubs) {
    if (isStubPublished(stub.name, existing, slug)) skipped.push(stub.name)
    else toPublish.push(stub)
  }
  if (toPublish.length === 0) return { published: [], skipped }

  // Snapshot before publishing so we can identify (and re-stamp) exactly the
  // files these stubs emit into the host migrations dir.
  const before = await snapshotMigrationDir(hostMigrationsDir)

  for (const stub of toPublish) {
    await codemods.makeUsingStub(root, join(manifest.migrations, stub.file), {})
  }

  const published = toPublish.map((stub) => stub.name)
  await finalizeNewMigrations(hostMigrationsDir, before, published, slug)

  return { published, skipped }
}

/**
 * Register a satellite's provider + commands in `adonisrc.ts`. The only place we
 * patch the host's rc file (the framework's sanctioned codemod); the host's
 * `config/multitenancy.ts` is never patched. We only print a snippet for it.
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
 * Human-readable one-liners for the wire permissions a satellite declares, so the
 * operator consents to concrete capabilities at install rather than opaque wire
 * strings. Unknown strings pass through verbatim (forward-compatible with a
 * future permission kind an older core does not recognize).
 */
export function describePluginPermissions(permissions: readonly string[]): string[] {
  return permissions.map((wire) => {
    if (wire === 'scheduler') return 'scheduler — registers background scheduled jobs'
    if (wire === 'network:external')
      return 'network:external — makes outbound calls to hosts outside the cluster'
    if (wire === 'db:write')
      return 'db:write — writes to the tenant database (only effective for a trusted plugin)'
    if (wire.startsWith('data_change:')) {
      const models = wire.slice('data_change:'.length).split(',').join(', ')
      return `data_change — observes writes on: ${models}`
    }
    return wire
  })
}

/**
 * Print the install reminder for a satellite: the permissions it requests, peer
 * installs, required env, the `requires` prerequisite, and the config snippet to
 * paste. The generalization of core's old `postPublishBilling` /
 * `postPublishConfigReminders`.
 */
export function printSatelliteManifest(logger: LoggerLike, manifest: SatelliteManifest): void {
  logger.log('')
  logger.log(`— ${manifest.name} satellite — additional setup —`)

  if (manifest.permissions && manifest.permissions.length > 0) {
    logger.log('Requested permissions (granted at install):')
    for (const line of describePluginPermissions(manifest.permissions)) logger.log(`  - ${line}`)
  }

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

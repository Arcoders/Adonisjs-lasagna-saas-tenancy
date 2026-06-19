/**
 * The declarative manifest a packaged satellite publishes under the
 * `"lasagnaSatellite"` key of its `package.json`. It is read at configure time
 * as plain JSON — the satellite package is NEVER imported or executed during
 * discovery, so reading a manifest is side-effect-free and safe even for a
 * package whose runtime requires a booted AdonisJS app.
 *
 * Only `name` is required. Everything else is optional and degrades gracefully:
 * a satellite with no `migrations` is a config-only feature; one with no
 * `provider` ships no AdonisJS provider (e.g. a service resolved on demand).
 */
export interface SatelliteManifest {
  /** Display + interactive label. Kebab-case by convention (e.g. `feature-flags`). */
  name: string

  /**
   * The Satellite ABI version this package was built against (a positive
   * integer; see `SATELLITE_API_VERSION`). `configure` refuses to wire a
   * satellite that needs a newer ABI than the installed core provides, and
   * warns on an older or undeclared one. Optional for backward compatibility:
   * a satellite that omits it is treated as "unverified" (warn, not fail).
   */
  satelliteApi?: number

  /**
   * Legacy / short names accepted by `configure --with=<alias>` in addition to
   * the full package name. Lets `--with=billing` keep resolving to
   * `@adonisjs-lasagna/billing` after the migrations move out of core.
   */
  aliases?: string[]

  /**
   * Directory of `.stub` migration files, relative to the package root. The
   * stubs use the same `{{{ exports({ to: app.migrationsPath(...) }) }}}` header
   * core's own stubs use, so they publish through `codemods.makeUsingStub`.
   * Must be a relative path inside the package (absolute paths and `..`
   * segments are rejected by `readSatelliteManifest`).
   */
  migrations?: string

  /**
   * Core satellite bundles this satellite needs published first (e.g. billing
   * needs `quotas` for `tenant_plans`). Auto-resolved on the core-orchestrated
   * `--with=` path; printed as a prerequisite by the package's own configure hook.
   */
  requires?: string[]

  /**
   * Other satellite PACKAGES this one depends on (e.g. a CRM that needs
   * `@adonisjs-lasagna/notifications`). Unlike `requires` (core feature
   * bundles), these are npm packages. `configure` pulls each dependency into the
   * selection, orders it BEFORE this satellite (so its provider boots first), and
   * fails on a missing dependency or a dependency cycle. The optional semver
   * `range` is checked best-effort against the installed version. Accepts a bare
   * package-name string as shorthand for `{ pkg }`.
   */
  dependsOn?: SatelliteDependency[]

  /** Subpath of the satellite's AdonisJS provider, added to `adonisrc.ts`. */
  provider?: string

  /** Subpath of the satellite's ace commands loader, added to `adonisrc.ts`. */
  commands?: string

  /** Required environment variables, printed as an install reminder. */
  env?: string[]

  /** Install commands (peer packages etc.), printed as an install reminder. */
  install?: string[]

  /** A config block the host pastes into `config/multitenancy.ts` (never patched). */
  configSnippet?: string

  /** Docs URL printed alongside the install reminder. */
  docs?: string
}

/** A declared dependency on another satellite package. */
export interface SatelliteDependency {
  /** The npm package name of the satellite this one depends on. */
  pkg: string
  /** Optional semver range, checked best-effort against the installed version. */
  range?: string
}

/** A satellite discovered in the host app's dependency tree. */
export interface DiscoveredSatellite {
  /** The npm package name (the key in the host's dependencies). */
  packageName: string
  /** Absolute path to the package root (the dir containing its package.json). */
  root: string
  /** The installed package version (from its package.json), if readable. */
  version?: string
  /** The parsed, validated manifest. */
  manifest: SatelliteManifest
}

/**
 * Parse `dependsOn`: an array whose entries are either a bare package-name
 * string (`"@me/dep"`) or an object `{ pkg, range? }`. Invalid entries are
 * dropped with a warning; an empty/invalid result yields `undefined`.
 */
function parseDependsOn(
  value: unknown,
  pkgName: string,
  onWarn: (m: string) => void
): SatelliteDependency[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) {
    onWarn(`[lasagna] ${pkgName}: "lasagnaSatellite.dependsOn" must be an array — dropping it`)
    return undefined
  }
  const out: SatelliteDependency[] = []
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      out.push({ pkg: entry })
    } else if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as any).pkg === 'string' &&
      (entry as any).pkg.length > 0
    ) {
      const dep: SatelliteDependency = { pkg: (entry as any).pkg }
      if (typeof (entry as any).range === 'string' && (entry as any).range.length > 0) {
        dep.range = (entry as any).range
      }
      out.push(dep)
    } else {
      onWarn(
        `[lasagna] ${pkgName}: a "lasagnaSatellite.dependsOn" entry must be a package name ` +
          `string or { pkg, range? } — dropping ${JSON.stringify(entry)}`
      )
    }
  }
  return out.length > 0 ? out : undefined
}

function cleanStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const out = value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return out.length > 0 ? out : undefined
}

/**
 * A relative path is "safe" when it does not escape the package root: not
 * absolute, no `..` segment, no leading drive letter / UNC. Rejecting these
 * stops a crafted manifest from making `configure` read or copy files from
 * outside the satellite package.
 */
export function isSafeRelativePath(p: string): boolean {
  if (typeof p !== 'string' || p.length === 0) return false
  if (p.startsWith('/') || p.startsWith('\\')) return false
  if (/^[a-zA-Z]:/.test(p)) return false // Windows drive
  const segments = p.split(/[\\/]/)
  return !segments.includes('..')
}

/**
 * Parse + validate the `lasagnaSatellite` key of a parsed `package.json`.
 * Returns `null` when the key is absent or has no usable `name`. Invalid
 * optional fields are dropped (with a warning via `onWarn`) rather than failing
 * the whole manifest. Pure: no fs, no logger import (so it is safe to call from
 * unit tests and from the configure hook alike — pass `command.logger.warning`
 * as `onWarn` there).
 */
export function readSatelliteManifest(
  pkgJson: unknown,
  onWarn: (message: string) => void = () => {}
): SatelliteManifest | null {
  if (!pkgJson || typeof pkgJson !== 'object') return null
  const raw = (pkgJson as Record<string, unknown>).lasagnaSatellite
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const obj = raw as Record<string, unknown>
  const pkgName =
    typeof (pkgJson as Record<string, unknown>).name === 'string'
      ? ((pkgJson as Record<string, unknown>).name as string)
      : '<unknown package>'

  if (typeof obj.name !== 'string' || obj.name.length === 0) {
    onWarn(`[lasagna] ${pkgName}: "lasagnaSatellite.name" is required — ignoring the manifest`)
    return null
  }

  const manifest: SatelliteManifest = { name: obj.name }

  if (obj.migrations !== undefined) {
    if (typeof obj.migrations === 'string' && isSafeRelativePath(obj.migrations)) {
      manifest.migrations = obj.migrations
    } else {
      onWarn(
        `[lasagna] ${pkgName}: "lasagnaSatellite.migrations" must be a relative path inside ` +
          `the package — dropping it`
      )
    }
  }

  manifest.aliases = cleanStringArray(obj.aliases)
  manifest.requires = cleanStringArray(obj.requires)
  manifest.env = cleanStringArray(obj.env)
  manifest.install = cleanStringArray(obj.install)

  const dependsOn = parseDependsOn(obj.dependsOn, pkgName, onWarn)
  if (dependsOn) manifest.dependsOn = dependsOn

  if (obj.satelliteApi !== undefined) {
    if (
      typeof obj.satelliteApi === 'number' &&
      Number.isInteger(obj.satelliteApi) &&
      obj.satelliteApi > 0
    ) {
      manifest.satelliteApi = obj.satelliteApi
    } else {
      onWarn(
        `[lasagna] ${pkgName}: "lasagnaSatellite.satelliteApi" must be a positive integer — ` +
          `dropping it`
      )
    }
  }

  // `provider` / `commands` are written verbatim into the host's `adonisrc.ts`
  // and imported (executed) on every boot. Validate them the same way as
  // `migrations`: a non-string is dropped silently, but a string that escapes
  // the package (absolute path or a `..` segment) is dropped with a warning so a
  // crafted manifest can't point the host's provider import outside the package.
  for (const key of ['provider', 'commands'] as const) {
    const val = obj[key]
    if (typeof val !== 'string') continue
    if (isSafeRelativePath(val)) {
      manifest[key] = val
    } else {
      onWarn(
        `[lasagna] ${pkgName}: "lasagnaSatellite.${key}" must be a safe module specifier ` +
          `(no absolute path, no ".." segment) — dropping it`
      )
    }
  }

  if (typeof obj.configSnippet === 'string') manifest.configSnippet = obj.configSnippet
  if (typeof obj.docs === 'string') manifest.docs = obj.docs

  // Drop the explicit-undefined keys so the returned object is clean.
  for (const k of ['aliases', 'requires', 'env', 'install'] as const) {
    if (manifest[k] === undefined) delete manifest[k]
  }

  return manifest
}

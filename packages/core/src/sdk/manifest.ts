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

/** A satellite discovered in the host app's dependency tree. */
export interface DiscoveredSatellite {
  /** The npm package name (the key in the host's dependencies). */
  packageName: string
  /** Absolute path to the package root (the dir containing its package.json). */
  root: string
  /** The parsed, validated manifest. */
  manifest: SatelliteManifest
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

  if (typeof obj.provider === 'string') manifest.provider = obj.provider
  if (typeof obj.commands === 'string') manifest.commands = obj.commands
  if (typeof obj.configSnippet === 'string') manifest.configSnippet = obj.configSnippet
  if (typeof obj.docs === 'string') manifest.docs = obj.docs

  // Drop the explicit-undefined keys so the returned object is clean.
  for (const k of ['aliases', 'requires', 'env', 'install'] as const) {
    if (manifest[k] === undefined) delete manifest[k]
  }

  return manifest
}

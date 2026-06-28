/**
 * Configuration + workspace discovery. The default config is derived from the
 * monorepo itself: every `packages/*` workspace with an `exports` map becomes a
 * set of public barrels (one per subpath), so a new satellite is covered the
 * moment it ships an `exports` entry, with no tool change. A real
 * `doc-coverage.config.ts` (RFC) would override these fields; phase-1 ships the
 * discovery default.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import type { BarrelSpec } from './symbols.js'
import type { SynonymMap } from './tokenize.js'

export interface PackageSpec {
  name: string
  /** Absolute package directory. */
  dir: string
  barrels: BarrelSpec[]
}

export interface DocCoverageConfig {
  repoRoot: string
  /** Absolute docs roots to scan (default: <repo>/docs). */
  docsRoots: string[]
  packages: PackageSpec[]
  synonyms: SynonymMap
  coverageFloors: { explained: number; exemplified: number }
  freshnessWindowDays: number
}

interface RawPackageJson {
  name?: string
  exports?: Record<string, string | Record<string, string>>
}

/** Map an `exports` target like `./build/src/services/index.js` to its `src/*.ts`. */
function exportTargetToSource(dir: string, target: string): string | null {
  const m = target.match(/^\.\/build\/(src\/.+)\.js$/)
  if (!m) return null
  const srcPath = join(dir, `${m[1]}.ts`)
  return existsSync(srcPath) ? srcPath : null
}

function barrelsForPackage(
  name: string,
  dir: string,
  exports: RawPackageJson['exports']
): BarrelSpec[] {
  const barrels: BarrelSpec[] = []
  for (const [key, value] of Object.entries(exports ?? {})) {
    const target = typeof value === 'string' ? value : (value['import'] ?? value['default'])
    if (typeof target !== 'string') continue
    const indexFile = exportTargetToSource(dir, target)
    if (!indexFile) continue
    const subpath = key === '.' ? '.' : key.replace(/^\.\//, '')
    const publicScope = subpath === '.' ? name : `${name}/${subpath}`
    barrels.push({
      subpath,
      packageName: name,
      publicScope,
      indexFile: indexFile.replace(/\\/g, '/'),
    })
  }
  return barrels
}

/** Discover every workspace package under `packages/*` that exposes an `exports` map. */
export function discoverPackages(repoRoot: string): PackageSpec[] {
  const packagesDir = join(repoRoot, 'packages')
  if (!existsSync(packagesDir)) return []
  const specs: PackageSpec[] = []
  for (const entry of readdirSync(packagesDir)) {
    const dir = join(packagesDir, entry)
    const pkgPath = join(dir, 'package.json')
    if (!existsSync(pkgPath)) continue
    let pkg: RawPackageJson
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as RawPackageJson
    } catch {
      continue
    }
    if (!pkg.name || !pkg.exports) continue
    const barrels = barrelsForPackage(pkg.name, dir, pkg.exports)
    if (barrels.length) specs.push({ name: pkg.name, dir, barrels })
  }
  return specs.sort((a, b) => a.name.localeCompare(b.name))
}

function loadSynonyms(repoRoot: string): SynonymMap {
  const path = join(repoRoot, 'doc-synonyms.json')
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as SynonymMap
  } catch {
    return {}
  }
}

export function defaultConfig(repoRoot: string): DocCoverageConfig {
  return {
    repoRoot,
    docsRoots: [join(repoRoot, 'docs')].filter((p) => existsSync(p)),
    packages: discoverPackages(repoRoot),
    synonyms: loadSynonyms(repoRoot),
    coverageFloors: { explained: 0, exemplified: 0 },
    freshnessWindowDays: 0,
  }
}

/** Find the monorepo root by walking up from a start dir to the package.json with `workspaces`. */
export function findRepoRoot(startDir: string): string {
  let dir = startDir
  for (let i = 0; i < 8; i++) {
    const pkgPath = join(dir, 'package.json')
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown }
        if (pkg.workspaces) return dir
      } catch {
        /* keep walking */
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return startDir
}

/** Repo-relative, forward-slashed. */
export function rel(repoRoot: string, abs: string): string {
  return relative(repoRoot, abs).replace(/\\/g, '/')
}

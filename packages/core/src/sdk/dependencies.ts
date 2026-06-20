import type { DiscoveredSatellite } from './manifest.js'

/**
 * Inter-satellite dependency resolution for `configure`. Pure (no fs, no
 * logger), so it is unit-testable and usable from a satellite's own configure
 * hook. Given the satellites the operator selected plus an index of everything
 * installed, it:
 *
 *   - pulls each `dependsOn` package into the working set (transitively),
 *   - orders dependencies BEFORE their dependents (so providers boot in order),
 *   - reports dependencies that are not installed (`missing`),
 *   - reports a dependency cycle if one exists (`cycle`),
 *   - checks each declared semver `range` best-effort against the installed
 *     version (`rangeMismatches`).
 *
 * `missing` and `cycle` are structural errors the caller should treat as a hard
 * failure. `rangeMismatches` are advisory: the range check is intentionally a
 * small, dependency-free subset of semver (see {@link satisfiesRange}), so an
 * unparseable range is treated as "satisfied" and never blocks.
 */

/** [major, minor, patch] */
type Triple = [number, number, number]

function parseVersion(v: string): Triple | null {
  if (typeof v !== 'string') return null
  const core = v.trim().replace(/^v/, '').split(/[-+]/)[0]
  const parts = core.split('.')
  if (parts.length === 0 || parts[0] === '') return null
  const nums = parts.map((p) => Number(p))
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0]
}

function cmp(a: Triple, b: Triple): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1
  }
  return 0
}

/** Upper bound (exclusive) of a caret range, per npm semver semantics. */
function caretUpper([maj, min, pat]: Triple): Triple {
  if (maj > 0) return [maj + 1, 0, 0]
  if (min > 0) return [0, min + 1, 0]
  // ^0.0.x pins the patch: ^0.0.3 := >=0.0.3 <0.0.4.
  return [0, 0, pat + 1]
}

/**
 * A deliberately small, dependency-free semver-range check. Supports: any
 * (`*` / `x` / `""`), exact (`1.2.3` / `=1.2.3`), comparators (`>= > <= <`),
 * caret (`^`) and tilde (`~`). Anything else (compound ranges with `||`, hyphen
 * ranges, whitespace-joined comparators) returns `null` — "cannot evaluate" —
 * and the caller treats it as satisfied. Pre-release / build metadata on the
 * version is ignored.
 *
 * @returns `true` / `false` when evaluable, `null` when the range is outside the
 *          supported subset.
 */
export function satisfiesRange(version: string, range: string): boolean | null {
  const ver = parseVersion(version)
  if (!ver) return null

  const r = range.trim()
  if (r === '' || r === '*' || r === 'x' || r === 'X' || r === 'latest') return true
  // Reject compound/unsupported ranges rather than mis-evaluating them.
  if (/\s|\|\|/.test(r)) return null

  // End-anchored: a range with trailing junk (`1.2.3.4`, `1.0beta`, `1.2.x.y`)
  // falls through to `null` ("cannot evaluate") instead of silently matching its
  // leading prefix and being treated as a clean range.
  const m = r.match(/^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+|x|X|\*))?(?:\.(\d+|x|X|\*))?$/)
  if (!m) return null
  const op = m[1] ?? '='
  const maj = Number(m[2])
  const minRaw = m[3]
  const patRaw = m[4]
  const minWild = minRaw === undefined || minRaw === 'x' || minRaw === 'X' || minRaw === '*'
  const patWild = patRaw === undefined || patRaw === 'x' || patRaw === 'X' || patRaw === '*'
  const min = minWild ? 0 : Number(minRaw)
  const pat = patWild ? 0 : Number(patRaw)
  const base: Triple = [maj, min, pat]

  switch (op) {
    case '^': {
      return cmp(ver, base) >= 0 && cmp(ver, caretUpper(base)) < 0
    }
    case '~': {
      // ~1.2.3 / ~1.2 → >=1.2.0 <1.3.0 ; ~1 → >=1.0.0 <2.0.0
      const upper: Triple = minWild ? [maj + 1, 0, 0] : [maj, min + 1, 0]
      return cmp(ver, base) >= 0 && cmp(ver, upper) < 0
    }
    case '>':
      return cmp(ver, base) > 0
    case '>=':
      return cmp(ver, base) >= 0
    case '<':
      return cmp(ver, base) < 0
    case '<=':
      return cmp(ver, base) <= 0
    case '=':
    default: {
      // Exact, honoring x-ranges: `1.x` → major must match; `1.2.x` → major+minor.
      if (minWild) return ver[0] === maj
      if (patWild) return ver[0] === maj && ver[1] === min
      return cmp(ver, base) === 0
    }
  }
}

export interface DependencyResolution {
  /** The closure (selected + pulled-in deps) in dependency-first order. */
  ordered: DiscoveredSatellite[]
  /** Declared dependencies that are not installed. */
  missing: Array<{ from: string; pkg: string }>
  /** A dependency cycle (package names), or null. */
  cycle: string[] | null
  /** Declared ranges not satisfied by the installed version (advisory). */
  rangeMismatches: Array<{ from: string; pkg: string; range: string; actual: string }>
}

/**
 * Resolve the dependency closure of `selected` against `index` (every installed
 * satellite, keyed by package name and alias — i.e. the output of
 * `indexSatellites`). See the module doc for the contract.
 */
export function resolveSatelliteDependencies(
  selected: DiscoveredSatellite[],
  index: Map<string, DiscoveredSatellite>
): DependencyResolution {
  const missing: DependencyResolution['missing'] = []
  const rangeMismatches: DependencyResolution['rangeMismatches'] = []

  // Build the working set (closure) keyed by package name, and the edges
  // dependency -> dependent.
  const nodes = new Map<string, DiscoveredSatellite>()
  const deps = new Map<string, Set<string>>() // node -> set of its dependency package names

  const queue: DiscoveredSatellite[] = []
  const enqueue = (sat: DiscoveredSatellite) => {
    if (nodes.has(sat.packageName)) return
    nodes.set(sat.packageName, sat)
    deps.set(sat.packageName, new Set())
    queue.push(sat)
  }
  for (const sat of selected) enqueue(sat)

  while (queue.length > 0) {
    const sat = queue.shift()!
    for (const dep of sat.manifest.dependsOn ?? []) {
      const resolved = index.get(dep.pkg)
      if (!resolved) {
        missing.push({ from: sat.packageName, pkg: dep.pkg })
        continue
      }
      if (dep.range && resolved.version) {
        const ok = satisfiesRange(resolved.version, dep.range)
        if (ok === false) {
          rangeMismatches.push({
            from: sat.packageName,
            pkg: resolved.packageName,
            range: dep.range,
            actual: resolved.version,
          })
        }
      }
      deps.get(sat.packageName)!.add(resolved.packageName)
      enqueue(resolved)
    }
  }

  // Kahn topological sort: dependencies before dependents. A dependent has one
  // in-edge per dependency.
  const indegree = new Map<string, number>()
  for (const [name, depSet] of deps) indegree.set(name, depSet.size)

  const ready: string[] = []
  for (const [name, d] of indegree) if (d === 0) ready.push(name)
  ready.sort() // deterministic order among independent satellites

  const ordered: DiscoveredSatellite[] = []
  while (ready.length > 0) {
    const name = ready.shift()!
    ordered.push(nodes.get(name)!)
    // Any node that depends on `name` loses an in-edge.
    for (const [other, depSet] of deps) {
      if (depSet.has(name)) {
        indegree.set(other, indegree.get(other)! - 1)
        if (indegree.get(other) === 0) {
          ready.push(other)
          ready.sort()
        }
      }
    }
  }

  let cycle: string[] | null = null
  if (ordered.length !== nodes.size) {
    cycle = [...nodes.keys()].filter((n) => !ordered.some((s) => s.packageName === n)).sort()
  }

  return { ordered, missing, cycle, rangeMismatches }
}

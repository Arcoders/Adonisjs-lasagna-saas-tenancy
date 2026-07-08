/**
 * Discover the satellites that ship an AdonisJS provider, by source, so the
 * provider guards (`check-abi-boot-assertion`, `check-plugin-permissions`) stop
 * carrying a hand-maintained list that silently omits a satellite (crypto and the
 * template were both missing from the hardcoded five). A satellite "ships a provider"
 * iff its `package.json#lasagnaSatellite.provider` is declared AND a
 * `providers/*_provider.ts` source exists.
 *
 * Returns, sorted by directory name, one entry per provider-shipping satellite:
 *   { key, dir, pkg (repo-relative package.json), provider (repo-relative source) }
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export function discoverSatelliteProviders(root) {
  const pkgsDir = join(root, 'packages')
  const out = []
  for (const dir of readdirSync(pkgsDir)) {
    const pkgJsonPath = join(pkgsDir, dir, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    let pkg
    try {
      pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    } catch {
      continue
    }
    const sat = pkg?.lasagnaSatellite
    // Only satellites that DECLARE a provider in their manifest ship one; a
    // library-only package (sso/admin) has no manifest provider entry.
    if (!sat || typeof sat !== 'object' || typeof sat.provider !== 'string') continue
    const providersDir = join(pkgsDir, dir, 'providers')
    if (!existsSync(providersDir)) continue
    const providerFile = readdirSync(providersDir).find((f) => /_provider\.ts$/.test(f))
    if (!providerFile) continue
    out.push({
      key: dir,
      dir,
      pkg: `packages/${dir}/package.json`,
      provider: `packages/${dir}/providers/${providerFile}`,
    })
  }
  return out.sort((a, b) => a.key.localeCompare(b.key))
}

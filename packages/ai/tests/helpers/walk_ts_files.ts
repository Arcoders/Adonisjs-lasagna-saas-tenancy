import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Recursively yields every `.ts` file under `dir`. Ported from the kernel's
 * tests helper of the same name so the architectural scans walk the source
 * tree identically on both sides of the package boundary.
 */
export function* walkTsFiles(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      yield* walkTsFiles(full)
    } else if (entry.endsWith('.ts')) {
      yield full
    }
  }
}

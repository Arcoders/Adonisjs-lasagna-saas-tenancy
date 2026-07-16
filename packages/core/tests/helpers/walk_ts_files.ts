import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Recursively yields every `.ts` file under `dir`. Shared by the
 * architectural specs (`no_unsafe_raw_sql`, `no_shell_spawn`) so the
 * source-tree walk they gate on cannot drift between them.
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

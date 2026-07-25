import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Yield every `.ts` file under `root` (recursive), skipping declaration files. Used by
 * the architectural specs that scan crypto src (the no-silent-guard scan, the registry
 * contract), mirroring the AI satellite's helper of the same name.
 */
export function* walkTsFiles(root: string): Generator<string> {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      yield* walkTsFiles(full)
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      yield full
    }
  }
}

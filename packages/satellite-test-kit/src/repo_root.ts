// Depth-independent workspace-root resolver. Replaces the brittle
// `../../../../` traversals in the architectural `*_documented` specs, so a spec
// can move to any directory depth (e.g. into `tests/@architecture/docs/`)
// without recalculating its path to the repo root. A pure resolver (over an
// injected reader) plus thin filesystem-backed wrappers.

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Walk up from `startDir` to the first ancestor whose package.json declares
 * `workspaces` (the monorepo root marker). Pure over the injected `readManifest`
 * and `parentOf`, so it is unit-testable without touching the filesystem.
 */
export function resolveWorkspaceRoot(
  startDir: string,
  deps: {
    readManifest: (dir: string) => { workspaces?: unknown } | undefined
    parentOf: (dir: string) => string
  }
): string {
  let dir = startDir
  for (;;) {
    const manifest = deps.readManifest(dir)
    if (manifest && manifest.workspaces !== undefined) return dir
    const parent = deps.parentOf(dir)
    if (parent === dir) {
      throw new Error(
        `resolveWorkspaceRoot: no package.json with a "workspaces" field found above ${startDir}`
      )
    }
    dir = parent
  }
}

/** Read a directory's package.json, or `undefined` if absent or unparseable. */
export function readPackageManifest(dir: string): { workspaces?: unknown } | undefined {
  const path = join(dir, 'package.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Resolve the monorepo root from a spec's `import.meta.url` (a `file:` URL) or a
 * plain directory path. Depth-independent: walks up to the package.json that
 * declares `workspaces`.
 */
export function repoRoot(from: string): string {
  const startDir = from.startsWith('file:') ? dirname(fileURLToPath(from)) : from
  return resolveWorkspaceRoot(startDir, { readManifest: readPackageManifest, parentOf: dirname })
}

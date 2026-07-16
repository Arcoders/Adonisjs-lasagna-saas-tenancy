// Deterministic spec-file discovery for both runners.
//
// Japa hands its suite `files` globs to fast-glob, which returns matches in
// arbitrary (filesystem readdir) order, and nothing downstream sorts them. So
// the execution order of spec files depends on the directory tree shape: adding
// a sibling directory can reorder the run across machines. That non-determinism
// is what turns a latent cross-spec state leak into an intermittent failure (and
// is exactly how an unrelated directory change once surfaced one).
//
// Resolving the globs here and sorting the absolute POSIX paths (fast-glob
// normalizes to forward slashes, so the order is stable cross-OS) gives a stable,
// reproducible order. Both runners pass japa a `files: () => resolveOrderedSpecFiles(...)`
// thunk; japa's FilesManager returns `await files()` verbatim for the function
// form (no re-glob, no re-order), so our order is preserved. A canary test pins
// that contract against the installed @japa/runner.
//
// Boot-safe: imports only `fast-glob` and `node:url` (no `@adonisjs/*`, lucid,
// the app, or `@japa/*`), so it is reachable from the no-build unit loop.

import fastGlob from 'fast-glob'
import { pathToFileURL } from 'node:url'

/**
 * Resolve `globs` (relative to `cwd`) to a deterministically ordered list of
 * spec file URLs. Sorted by absolute POSIX path so the order is identical across
 * runs and operating systems, independent of the directory tree shape.
 */
export async function resolveOrderedSpecFiles(
  globs: string[],
  cwd: string,
  ignore?: string[]
): Promise<URL[]> {
  const files = await fastGlob(globs, {
    cwd,
    absolute: true,
    onlyFiles: true,
    ...(ignore !== undefined ? { ignore } : {}),
  })
  files.sort()
  return files.map((file) => pathToFileURL(file))
}

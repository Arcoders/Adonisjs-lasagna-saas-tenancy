// Reusable anti-drift guard for the guarantee-oriented test tree, shared by
// every package so the layout is single-sourced and proven consistent rather
// than aspirational. A spec in each package calls `assertGuaranteeTree` against
// its own `tests/` dir; the validation logic lives here once.
//
// Pure: imports only `node:fs`/`node:url` and the taxonomy constants, so it is
// safe in the no-build unit loop (reached by a relative source path) and never
// pulls in `@adonisjs/*`, lucid, the app, or `@japa/*`.
//
// Reads directories only (no Ignitor, no DB). The guarantee a spec belongs to
// is encoded in its PATH, and the runners filter on that path, so a typo'd
// directory (`@guarantees/isolaton/`) or a stray legacy `unit/` at the top
// level would silently fall out of every view. This pins the layout against the
// single-source taxonomy, so the structure cannot drift unnoticed.

import { readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  GUARANTEES,
  HARNESS_LEAVES,
  ARCHITECTURE_TIERS,
  INTEGRATION_TIERS,
  TOP_LEVEL_DIRS,
} from './guarantees.js'

/** The slice of Japa's `assert` this guard needs. */
export interface TreeAssert {
  deepEqual(actual: unknown, expected: unknown, message?: string): void
}

/** Directory names directly under `url`, or `[]` when the path does not exist. */
function subdirs(url: URL): string[] {
  const dir = fileURLToPath(url)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

/** The members of `names` that are not in `allowed`. */
function notIn(names: string[], allowed: readonly string[]): string[] {
  return names.filter((name) => !allowed.includes(name))
}

/**
 * Assert that the package test tree rooted at `testsRootUrl` (a URL ending in a
 * slash, e.g. `new URL('../../', import.meta.url)` from
 * `tests/@architecture/boundaries/`) matches the single-sourced taxonomy:
 *
 * - top-level dirs are a subset of TOP_LEVEL_DIRS,
 * - `@guarantees/*` are known guarantees, each holding only `unit`/`integration`,
 * - `@architecture/*` are known architecture tiers,
 * - `@integration/*` are known integration tiers.
 *
 * Every check is presence-guarded, so an absent optional directory is a pass.
 * Adding a guarantee, tier, or top-level dir means editing the matching
 * constant in `guarantees.ts` (one place) and nothing else can drift.
 */
export function assertGuaranteeTree(testsRootUrl: URL, assert: TreeAssert): void {
  const topLevel = subdirs(testsRootUrl)
  assert.deepEqual(
    notIn(topLevel, TOP_LEVEL_DIRS),
    [],
    `Top-level directories under tests/ that are not in TOP_LEVEL_DIRS (a stray legacy dir, or add it to the taxonomy): ${notIn(topLevel, TOP_LEVEL_DIRS).join(', ')}`
  )

  const guarantees = subdirs(new URL('@guarantees/', testsRootUrl))
  assert.deepEqual(
    notIn(guarantees, GUARANTEES),
    [],
    `Directories under tests/@guarantees/ that are not in GUARANTEES (typo, or add it to the taxonomy): ${notIn(guarantees, GUARANTEES).join(', ')}`
  )
  for (const guarantee of guarantees) {
    const leaves = subdirs(new URL(`@guarantees/${guarantee}/`, testsRootUrl))
    assert.deepEqual(
      notIn(leaves, HARNESS_LEAVES),
      [],
      `@guarantees/${guarantee} has non-harness directories (only unit/ and integration/ are allowed): ${notIn(leaves, HARNESS_LEAVES).join(', ')}`
    )
  }

  const architecture = subdirs(new URL('@architecture/', testsRootUrl))
  assert.deepEqual(
    notIn(architecture, ARCHITECTURE_TIERS),
    [],
    `Directories under tests/@architecture/ that are not in ARCHITECTURE_TIERS: ${notIn(architecture, ARCHITECTURE_TIERS).join(', ')}`
  )

  const integration = subdirs(new URL('@integration/', testsRootUrl))
  assert.deepEqual(
    notIn(integration, INTEGRATION_TIERS),
    [],
    `Directories under tests/@integration/ that are not in INTEGRATION_TIERS: ${notIn(integration, INTEGRATION_TIERS).join(', ')}`
  )
}

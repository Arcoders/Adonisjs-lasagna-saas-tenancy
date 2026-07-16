#!/usr/bin/env node
/**
 * api-extractor golden-diff gate (Documentation Coverage, RFC §8 / B2).
 *
 * For every api-extractor config across the workspace, regenerate that entry
 * point's public-API rollup and diff it against its committed `etc/<name>.api.md`.
 * A public-API change that did not update the report fails CI. The fix is one
 * command, printed on failure.
 *
 * A package opts a surface into the golden by dropping an api-extractor config
 * beside its package.json. The base `api-extractor.json` pins the MAIN entry
 * point; sibling per-entry configs (`api-extractor.plugin.json`,
 * `api-extractor.sdk.json`, …) pin subpath barrels that the main entry never
 * reaches. Each config names its own `mainEntryPointFilePath` + report file, so
 * one package can pin many independent public surfaces. Without this, `/plugin`
 * and `/sdk` were invisible to the gate.
 *
 * Per-entry opt-in: a package with no config is skipped, not failed. An entry
 * whose declarations are missing (`build/src/.../*.d.ts`) is also skipped, so
 * this never masquerades a "not built" as drift.
 *
 * Uses api-extractor's programmatic API (no spawn, no shell). Run from the repo
 * root AFTER `npm run build:all`:  node scripts/check-api-report.mjs
 */
import { readdirSync, existsSync } from 'node:fs'
import { join, basename } from 'node:path'
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor'

const root = process.cwd()
const pkgsDir = join(root, 'packages')

// `api-extractor.json` or `api-extractor.<entry>.json`, in any package. Sorted so
// the run order (and its log) is deterministic across platforms.
const isConfig = (f) => /^api-extractor(\.[^.]+)?\.json$/.test(f)

const configs = []
for (const pkg of readdirSync(pkgsDir).sort()) {
  const dir = join(pkgsDir, pkg)
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    continue // not a directory
  }
  for (const f of entries.filter(isConfig).sort()) {
    configs.push({ pkg, configPath: join(dir, f) })
  }
}

if (configs.length === 0) {
  console.log('check-api-report: no packages opted in (no api-extractor*.json). Skipping.')
  process.exit(0)
}

let failed = false
let checked = 0
let skipped = 0
for (const { pkg, configPath } of configs) {
  const config = ExtractorConfig.loadFileAndPrepare(configPath)
  // Skip an entry whose declarations are not built yet (run a build first).
  if (!existsSync(config.mainEntryPointFilePath)) {
    console.log(
      `check-api-report: ${pkg}:${basename(configPath)} entry not built ` +
        `(${config.mainEntryPointFilePath} missing), skipping`
    )
    skipped++
    continue
  }
  checked++
  const label = `${pkg}:${basename(config.reportFilePath)}`
  // localBuild:false = CI/verify mode: do not overwrite the committed report,
  // just report whether it would change.
  const result = Extractor.invoke(config, { localBuild: false, showVerboseMessages: false })

  if (result.succeeded && !result.apiReportChanged) {
    console.log(`check-api-report: ${label} in sync`)
  } else {
    failed = true
    const reason = result.apiReportChanged
      ? 'public API changed but the committed etc/*.api.md was not updated'
      : `extraction failed (${result.errorCount} error(s))`
    console.error(
      `check-api-report: ${label} ${reason}.\n` +
        `  Fix: ( cd packages/${pkg} && npx api-extractor run --local --config ${basename(configPath)} )` +
        ` and commit the updated etc/*.api.md`
    )
  }
}

if (checked === 0) {
  console.log('check-api-report: opted-in entries not built yet, run a build first. Skipping.')
  process.exit(0)
}
if (failed) process.exit(1)
console.log(
  `check-api-report: passed (${checked} ${checked === 1 ? 'entry' : 'entries'} verified` +
    `${skipped ? `, ${skipped} skipped` : ''})`
)

#!/usr/bin/env node
/**
 * api-extractor golden-diff gate (Documentation Coverage, RFC §8 / B2).
 *
 * For every package that opts in with an `api-extractor.json`, regenerate its
 * public-API rollup and diff it against the committed `etc/<pkg>.api.md`. A
 * public-API change that did not update the report fails CI. The fix is one
 * command, printed on failure: `cd packages/<pkg> && npx api-extractor run --local`.
 *
 * Per-package opt-in: a package without the config is skipped, not failed. A
 * package whose `build/src/index.d.ts` is missing is also skipped (run a build
 * first), so this never masquerades a "not built" as drift.
 *
 * Uses api-extractor's programmatic API (no spawn, no shell). Run from the repo
 * root AFTER `npm run build:all`:  node scripts/check-api-report.mjs
 */
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor'

const root = process.cwd()
const pkgsDir = join(root, 'packages')

const opted = readdirSync(pkgsDir).filter((p) => existsSync(join(pkgsDir, p, 'api-extractor.json')))

if (opted.length === 0) {
  console.log('check-api-report: no packages opted in (no api-extractor.json). Skipping.')
  process.exit(0)
}

let failed = false
let checked = 0
for (const pkg of opted) {
  const dir = join(pkgsDir, pkg)
  if (!existsSync(join(dir, 'build', 'src', 'index.d.ts'))) {
    console.log(`check-api-report: ${pkg} not built (no build/src/index.d.ts), skipping`)
    continue
  }
  checked++
  const config = ExtractorConfig.loadFileAndPrepare(join(dir, 'api-extractor.json'))
  // localBuild:false = CI/verify mode: do not overwrite the committed report,
  // just report whether it would change.
  const result = Extractor.invoke(config, { localBuild: false, showVerboseMessages: false })

  if (result.succeeded && !result.apiReportChanged) {
    console.log(`check-api-report: ${pkg} .api.md in sync`)
  } else {
    failed = true
    const reason = result.apiReportChanged ? 'public API changed but etc/*.api.md was not updated' : `extraction failed (${result.errorCount} error(s))`
    console.error(
      `check-api-report: ${pkg} ${reason}.\n` +
        `  Fix: ( cd packages/${pkg} && npx api-extractor run --local ) and commit the updated etc/*.api.md`
    )
  }
}

if (checked === 0) {
  console.log('check-api-report: opted-in packages not built yet, run a build first. Skipping.')
  process.exit(0)
}
if (failed) process.exit(1)
console.log(`check-api-report: passed (${checked} package(s) verified)`)

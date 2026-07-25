#!/usr/bin/env node
/**
 * Fail when a package's typecheck does not cover its own tests.
 *
 * A package whose `tsconfig.json` include lists only `src/**` still typechecks
 * clean while its specs are full of type errors, because tsc never reads them.
 * That is not a tidiness problem. It cost us real coverage: a signature change to
 * `authorizeToolScope(ctx, tenant, toolName, config)` -> `(ctx, tenant, tool, config)`
 * left every spec passing the string `'read'` where an object was expected, and the
 * suite stayed green because `'read'.name` is undefined and an undefined mode
 * happened to read as the default. Doctor specs were calling `check.run()` with no
 * arguments against a `run(ctx: DoctorContext)` contract. The repo-wide
 * `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` hardening had never
 * touched a single spec.
 *
 * The shape this pins is the one core has always had, and the reason there are two
 * config files rather than one: a single tsconfig cannot both emit only the shipped
 * surface and check everything, so `tsconfig.json` checks (tests included) and
 * `tsconfig.build.json` emits (tests excluded). The failure mode this guard exists
 * to prevent is somebody "fixing" a noisy spec by quietly dropping `tests/**` from
 * the include again, which reads as a one-line cleanup and silently turns the whole
 * suite back into untyped JavaScript.
 *
 * Checks, per package that has a tests/ directory:
 *   1. `tsconfig.json` include covers tests/.
 *   2. `tsconfig.json` does NOT emit (no outDir), so it cannot be the build config.
 *   3. `tsconfig.build.json` exists and does NOT include tests/.
 *   4. the `build` script points at tsconfig.build.json, not tsconfig.json.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readJsonc } from './read-jsonc.mjs'

const root = process.cwd()
const packagesDir = join(root, 'packages')

/** Does an `include` array reach into tests/? */
const coversTests = (include) =>
  Array.isArray(include) && include.some((pattern) => pattern.replace(/\\/g, '/').startsWith('tests/'))

const problems = []
let checked = 0

for (const name of readdirSync(packagesDir)) {
  const dir = join(packagesDir, name)
  const tsconfigPath = join(dir, 'tsconfig.json')
  const buildPath = join(dir, 'tsconfig.build.json')
  const pkgPath = join(dir, 'package.json')

  // Only packages that ship both a tsconfig and specs are in scope. A package with
  // no tests/ has nothing to cover and needs no split.
  if (!existsSync(tsconfigPath) || !existsSync(pkgPath)) continue
  if (!existsSync(join(dir, 'tests'))) continue
  checked += 1

  let tsconfig
  let pkg
  try {
    tsconfig = readJsonc(tsconfigPath)
    pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  } catch (error) {
    problems.push(`packages/${name}: could not parse tsconfig.json or package.json (${error.message})`)
    continue
  }

  if (!coversTests(tsconfig.include)) {
    problems.push(
      `packages/${name}/tsconfig.json: "include" does not cover tests/. Its specs are never ` +
        `typechecked, so a signature change can leave them passing garbage. Add "tests/**/*.ts".`
    )
  }
  if (tsconfig.compilerOptions?.outDir) {
    problems.push(
      `packages/${name}/tsconfig.json: sets "outDir", so it is being used to emit. The typecheck ` +
        `config must not emit, or including tests/ would ship them. Move outDir/rootDir to ` +
        `tsconfig.build.json.`
    )
  }
  if (!existsSync(buildPath)) {
    problems.push(
      `packages/${name}: no tsconfig.build.json. The build needs its own config that EXCLUDES ` +
        `tests/, otherwise including them for the typecheck would emit them into build/.`
    )
    continue
  }

  let buildConfig
  try {
    buildConfig = readJsonc(buildPath)
  } catch (error) {
    problems.push(`packages/${name}: could not parse tsconfig.build.json (${error.message})`)
    continue
  }

  if (coversTests(buildConfig.include)) {
    problems.push(
      `packages/${name}/tsconfig.build.json: "include" covers tests/, so the build would emit ` +
        `specs into build/ and ship them to npm.`
    )
  }
  const build = pkg.scripts?.build ?? ''
  if (build && !build.includes('tsconfig.build.json')) {
    problems.push(
      `packages/${name}/package.json: the "build" script does not use tsconfig.build.json, so it ` +
        `emits through the typecheck config and would ship tests/. Found: ${build}`
    )
  }
}

if (problems.length > 0) {
  console.error('check-typecheck-covers-tests: FAIL')
  for (const problem of problems) console.error(`  - ${problem}`)
  console.error(
    '\nEvery package must typecheck its own specs. Two configs: tsconfig.json checks (tests\n' +
      'included, no outDir), tsconfig.build.json emits (tests excluded). packages/core and\n' +
      'packages/ai are the reference.'
  )
  process.exit(1)
}

console.log(
  `check-typecheck-covers-tests: OK (${checked} package(s) with tests; each typechecks its specs ` +
    `and builds through a separate config)`
)

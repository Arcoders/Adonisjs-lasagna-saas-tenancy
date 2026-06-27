#!/usr/bin/env node
// Guards the @adonisjs/queue peer in core/billing/backup on two axes:
//
//  1. RANGE — it must be WIDENED past a single 0.x minor. A `^0.6.0` caret caps
//     at <0.7.0, so a queue 0.7.0 release would break every install. Require an
//     explicit `||` union or an upper bound (e.g. ">=0.6.0 <1").
//
//  2. OPTIONAL vs REQUIRED — DERIVED from each package's main barrel, never
//     hardcoded. The queue-backed jobs `extends Job`, so re-exporting them from a
//     package's `src/index.ts` pulls @adonisjs/queue into the module graph of
//     every `import '<pkg>'`. Therefore:
//       - a barrel that re-exports `./jobs/*` eager-loads the peer, so declaring
//         it OPTIONAL is a lie — it must be a REQUIRED peer (core's mistake to
//         avoid is the inverse: billing/backup need a worker to function);
//       - a barrel that keeps jobs OFF the main entry (jobs only on the `/jobs`
//         subpath, as core does) can honour "optional", so it MUST be optional —
//         don't force the peer onto hosts that run no background jobs.
//
// WS-8 / adonisjs-queue-0x-peer-frozen (+ follow-up: barrel/peer consistency).
// Ships `--self-test`.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const r = (p) => join(ROOT, p)

const PKGS = ['packages/core', 'packages/billing', 'packages/backup']
const DEP = '@adonisjs/queue'
// A re-export (or import) from the package's local `./jobs/` directory in its
// main barrel — the signal that `import '<pkg>'` eager-loads the queue peer.
const BARREL_LOADS_JOBS = /(?:from|import)\s+['"]\.\/jobs\//

/**
 * Pure rule over a parsed package.json and its main-barrel source. `barrelSrc`
 * is '' when the package has no `src/index.ts`.
 */
function lint(pkg, barrelSrc) {
  const problems = []
  const range = pkg.peerDependencies?.[DEP]
  if (!range) {
    problems.push(`no ${DEP} peerDependency`)
    return problems
  }
  // A bare 0.x caret (^0.x.y) resolves to >=0.x.y <0.(x+1).0 — capped at the next
  // 0.x minor. Require an explicitly widened range (a `||` union or an upper `<1`).
  if (/^\^0\./.test(range)) {
    problems.push(`${DEP} range "${range}" caps at the next 0.x minor; widen it (e.g. ">=0.6.0 <1")`)
  }

  const barrelLoadsQueue = BARREL_LOADS_JOBS.test(barrelSrc)
  const isOptional = pkg.peerDependenciesMeta?.[DEP]?.optional === true
  if (barrelLoadsQueue && isOptional) {
    problems.push(
      `${DEP} is declared optional, but the main barrel re-exports ./jobs/* (so ` +
        `import '${pkg.name ?? 'the package'}' eager-loads the peer). Make it a ` +
        `required peer (drop peerDependenciesMeta.optional) or move jobs off the main barrel.`
    )
  }
  if (!barrelLoadsQueue && !isOptional) {
    problems.push(
      `${DEP} is a required peer, but the main barrel keeps jobs off the main entry. ` +
        `Declare it optional in peerDependenciesMeta so hosts that run no background jobs ` +
        `are not forced to install it.`
    )
  }
  return problems
}

if (process.argv.includes('--self-test')) {
  const widened = { [DEP]: '>=0.6.0 <1' }
  const optMeta = { peerDependenciesMeta: { [DEP]: { optional: true } } }
  const jobsBarrel = `export { default as Foo } from './jobs/foo.js'`
  const cleanBarrel = `export { Service } from './services/index.js'`
  const failures = []

  // capped range is flagged regardless of the rest
  if (lint({ peerDependencies: { [DEP]: '^0.6.0' }, ...optMeta }, cleanBarrel).length === 0) {
    failures.push('capped-range fixture passed')
  }
  // barrel re-exports jobs + optional => MUST flag (the lie)
  if (lint({ peerDependencies: widened, ...optMeta }, jobsBarrel).length === 0) {
    failures.push('jobs-barrel + optional fixture passed (should require)')
  }
  // barrel re-exports jobs + required => OK
  if (lint({ peerDependencies: widened }, jobsBarrel).length !== 0) {
    failures.push('jobs-barrel + required fixture flagged')
  }
  // barrel keeps jobs off + optional => OK
  if (lint({ peerDependencies: widened, ...optMeta }, cleanBarrel).length !== 0) {
    failures.push('clean-barrel + optional fixture flagged')
  }
  // barrel keeps jobs off + required => MUST flag (should be optional)
  if (lint({ peerDependencies: widened }, cleanBarrel).length === 0) {
    failures.push('clean-barrel + required fixture passed (should be optional)')
  }
  // missing peer
  if (lint({}, cleanBarrel).length === 0) {
    failures.push('missing-peer fixture passed')
  }

  if (failures.length) {
    console.error('check-peer-ranges --self-test: FAIL')
    for (const f of failures) console.error(`  - ${f}`)
    process.exit(1)
  }
  console.log('check-peer-ranges --self-test: OK')
  process.exit(0)
}

const errors = []
for (const p of PKGS) {
  const manifest = join(p, 'package.json')
  if (!existsSync(r(manifest))) {
    errors.push(`missing ${manifest}`)
    continue
  }
  const barrel = join(p, 'src/index.ts')
  const barrelSrc = existsSync(r(barrel)) ? readFileSync(r(barrel), 'utf8') : ''
  for (const problem of lint(JSON.parse(readFileSync(r(manifest), 'utf8')), barrelSrc)) {
    errors.push(`${p}: ${problem}`)
  }
}

if (errors.length > 0) {
  console.error('check-peer-ranges: FAIL')
  for (const e of errors) console.error(`  - ${e}`)
  process.exit(1)
}

console.log(`check-peer-ranges: OK (${PKGS.length} packages verified)`)

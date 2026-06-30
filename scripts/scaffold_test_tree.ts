/**
 * Materialize the uniform guarantee-tree skeleton in a package's tests/ dir.
 *
 * The shape is single-sourced from the kit taxonomy (GUARANTEES,
 * ARCHITECTURE_TIERS), so this stays in lockstep with the runners and the
 * anti-drift guard. Every japa package gets the same skeleton: all five
 * guarantees with both harness leaves, the three architecture tiers, the gating
 * @integration/drivers tier, and a helpers/ slot. Empty slots carry a README so
 * the directory is tracked and self-documenting instead of an invisible stub.
 *
 * The chaos tier (@integration/fault_injection) and the fixture app
 * (tests/fixtures) are core-only by necessity (no satellite has its own fault
 * runner or Ignitor fixture), so this never creates them; core already has them.
 *
 * Idempotent and re-runnable. New satellites run `npm run scaffold:tests` to get
 * the canonical layout. Run with no args to scaffold every japa package, or pass
 * package directory names (e.g. `tsx scripts/scaffold-test-tree.ts admin sso`).
 *
 * Usage: npm run scaffold:tests [-- <pkgDir>...]
 */
import { readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, dirname } from 'node:path'
import { GUARANTEES, ARCHITECTURE_TIERS } from '../packages/satellite-test-kit/src/guarantees.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** A japa package is any packages/* that already has a tests/@guarantees tree. */
function japaPackages(): string[] {
  const packagesDir = join(ROOT, 'packages')
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => existsSync(join(packagesDir, name, 'tests', '@guarantees')))
    .sort()
}

const HARNESS_BLURB: Record<string, string> = {
  unit: 'runs against source with tsx, no database.',
  integration: 'boots the shared AdonisJS Ignitor and PostgreSQL.',
}

function guaranteeLeafReadme(guarantee: string, harness: string): string {
  return `# @guarantees/${guarantee}/${harness}

Specs proving the **${guarantee}** guarantee in the ${harness} harness, which ${HARNESS_BLURB[harness]}

Name new specs \`${guarantee}_<context>_<outcome>.spec.ts\`. This directory is a
placeholder until the first ${guarantee} ${harness} spec lands; the README keeps
the slot visible and tracked. Delete it once specs live here.
`
}

const ARCH_BLURB: Record<string, string> = {
  boundaries:
    'Structural guards: source-walk specs that pin architectural rules (no ad-hoc stateful services, no unsafe raw SQL, the guarantee tree itself, and so on).',
  contracts:
    'Contract specs that pin the package public surface (exports, ABI, command and config shape).',
  docs: 'Integrity specs (the *_documented guards) that fail when code drifts from its documentation.',
}

function archTierReadme(tier: string): string {
  return `# @architecture/${tier}

${ARCH_BLURB[tier]}

Runs in the unit harness (no database). Placeholder until the first ${tier} spec
lands here; the README keeps the slot visible and tracked.
`
}

const DRIVERS_README = `# @integration/drivers

Driver-level integration specs that are gated on every integration run (the
isolation drivers and adapter matrix). Stack harness: a real Ignitor and
PostgreSQL. Placeholder until the first driver spec lands here.
`

const HELPERS_README = `# helpers

Shared, non-spec test support for this package (factories, doubles, setup and
teardown). Nothing here is collected by a runner. Placeholder until shared
helpers are needed.
`

function treeReadme(pkg: string): string {
  return `# ${pkg} test tree

Tests are organised by **guarantee** (what the system promises), not by mechanism.
The harness (unit vs integration) is the leaf inside each guarantee, so a runner
still selects only the specs it can run.

\`\`\`
tests/
  @guarantees/<g>/{unit,integration}/   g = ${GUARANTEES.join(' | ')}
  @architecture/{${ARCHITECTURE_TIERS.join(',')}}/   static guards (unit harness)
  @integration/drivers/                 gating stack tier
  helpers/                              shared, non-spec support
\`\`\`

unit specs run against source with tsx and no database; integration specs boot
the shared Ignitor and PostgreSQL. Every package ships the same skeleton so the
layout reads the same everywhere; empty slots carry a README until specs arrive.
The chaos tier (\`@integration/fault_injection\`) and the fixture app
(\`tests/fixtures\`) live only in core.

Name guarantee specs \`<guarantee>_<context>_<outcome>.spec.ts\`. The
\`@architecture/boundaries/<pkg>_guarantee_tree\` spec calls the kit's
\`assertGuaranteeTree\`, so this layout is pinned against the single-sourced
taxonomy and cannot drift unnoticed.
`
}

/** Create `dir` and, if it holds no files, drop a README so it is tracked. */
function ensureSlot(dir: string, readme: string): { created: boolean; readme: boolean } {
  const created = !existsSync(dir)
  mkdirSync(dir, { recursive: true })
  const entries = readdirSync(dir, { withFileTypes: true })
  const hasFile = entries.some((e) => e.isFile())
  if (!hasFile) {
    writeFileSync(join(dir, 'README.md'), readme)
    return { created, readme: true }
  }
  return { created, readme: false }
}

function scaffold(pkg: string): void {
  const testsDir = join(ROOT, 'packages', pkg, 'tests')
  if (!existsSync(testsDir)) {
    console.log(`skip (no tests/): ${pkg}`)
    return
  }
  let slots = 0
  let readmes = 0
  const note = (r: { created: boolean; readme: boolean }) => {
    slots++
    if (r.readme) readmes++
  }

  for (const guarantee of GUARANTEES) {
    for (const harness of ['unit', 'integration']) {
      note(
        ensureSlot(
          join(testsDir, '@guarantees', guarantee, harness),
          guaranteeLeafReadme(guarantee, harness)
        )
      )
    }
  }
  for (const tier of ARCHITECTURE_TIERS) {
    note(ensureSlot(join(testsDir, '@architecture', tier), archTierReadme(tier)))
  }
  note(ensureSlot(join(testsDir, '@integration', 'drivers'), DRIVERS_README))
  note(ensureSlot(join(testsDir, 'helpers'), HELPERS_README))

  writeFileSync(join(testsDir, 'README.md'), treeReadme(pkg))
  console.log(
    `${pkg}: ${slots} slots ensured, ${readmes} README placeholders, tests/README.md written`
  )
}

const args = process.argv.slice(2)
const targets = args.length > 0 ? args : japaPackages()
console.log(`scaffolding: ${targets.join(', ')}`)
for (const pkg of targets) scaffold(pkg)

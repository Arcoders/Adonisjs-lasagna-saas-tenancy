import { test } from '@japa/runner'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Docs-integrity guard #1 of 3: every ace command shipped by any package in the
 * monorepo must be documented on the CLI reference page.
 *
 * The "registered" set is the source of truth that ace itself reads: each
 * package's `src/commands/commands.json` manifest (the same file copied into
 * `build/` and loaded by the kernel). The "documented" set is the raw markdown
 * of docs/reference/commands.md — a command counts as documented when its exact
 * `commandName` appears anywhere on the page (it's always inside an inline-code
 * span, e.g. `tenant:create <name> <email>`).
 *
 * This fails the moment a new command ships without a docs row, which is exactly
 * the drift this initiative is closing. It reads files only (no Ignitor, no DB),
 * so it runs in the architectural group alongside the other source-walk specs.
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(HERE, '..', '..', '..', '..')
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
const COMMANDS_DOC = join(REPO_ROOT, 'docs', 'reference', 'commands.md')

/**
 * Commands intentionally absent from the public CLI reference. Keep this list
 * short and justified — it is the live debt ledger, not a dumping ground.
 */
const ALLOWED_UNDOCUMENTED = new Set<string>([
  // The satellite template ships a teaching-only example command; it is
  // documented as a pattern in the creating-a-satellite guide, not as a real
  // operator command on the CLI reference.
  'example:widget:list',
])

interface CommandManifest {
  commands?: Array<{ commandName?: string }>
}

/** Every `<pkg>/src/commands/commands.json` manifest in the workspace. */
function manifestPaths(): string[] {
  if (!existsSync(PACKAGES_DIR)) return []
  const out: string[] = []
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const manifest = join(PACKAGES_DIR, pkg, 'src', 'commands', 'commands.json')
    if (existsSync(manifest)) out.push(manifest)
  }
  return out
}

function registeredCommands(): { name: string; pkg: string }[] {
  const out: { name: string; pkg: string }[] = []
  for (const path of manifestPaths()) {
    const pkg = path.split(/[\\/]/).slice(-4)[0] // packages/<pkg>/src/commands/commands.json
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as CommandManifest
    for (const cmd of manifest.commands ?? []) {
      if (cmd.commandName) out.push({ name: cmd.commandName, pkg })
    }
  }
  return out
}

test.group('Docs integrity: CLI commands', () => {
  test('every registered ace command is documented on the CLI reference page', ({ assert }) => {
    const doc = readFileSync(COMMANDS_DOC, 'utf8')
    const commands = registeredCommands()

    // Sanity: the manifests were found and parsed.
    assert.isAbove(
      commands.length,
      0,
      'expected to discover command manifests under packages/*/src/commands'
    )

    const undocumented = commands
      .filter(({ name }) => !ALLOWED_UNDOCUMENTED.has(name))
      .filter(({ name }) => !doc.includes(name))
      .map(({ name, pkg }) => `${name} (${pkg})`)

    assert.deepEqual(
      undocumented,
      [],
      [
        'These ace commands are registered but not documented in docs/reference/commands.md:',
        ...undocumented.map((c) => `  - ${c}`),
        '',
        'Add a row to the CLI reference (or, if it is intentionally hidden, add it to',
        'ALLOWED_UNDOCUMENTED in this spec with a one-line justification).',
      ].join('\n')
    )
  })
})

import { test } from '@japa/runner'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Docs-integrity for the crypto satellite (the crypto twin of core's
 * `@architecture/docs/*_documented.spec.ts`). Core's docs specs pin the CENTRAL
 * reference against every package; this pins the crypto SATELLITE PAGE
 * (`docs/guides/satellites/crypto.md`), the page an operator actually reads to run
 * crypto, against crypto's own runtime surface, so a new command, config option, or
 * a contract bump can't ship without its docs row. It reads files only (no Ignitor,
 * no DB), so it belongs in the architectural tier.
 */

const PKG_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const CRYPTO_DOC = REPO_ROOT + 'docs/guides/satellites/crypto.md'
const COMMANDS_MANIFEST = PKG_ROOT + 'src/commands/commands.json'
const DEFINE_CONFIG = PKG_ROOT + 'src/define_config.ts'
const CONTRACT_VERSION = PKG_ROOT + 'src/sdk/contract_version.ts'

function doc(): string {
  return readFileSync(CRYPTO_DOC, 'utf8')
}

/** Registered crypto ace commands, from the manifest ace itself loads. */
function registeredCommands(): string[] {
  const manifest = JSON.parse(readFileSync(COMMANDS_MANIFEST, 'utf8')) as {
    commands?: Array<{ commandName?: string }>
  }
  return (manifest.commands ?? []).map((c) => c.commandName).filter((n): n is string => !!n)
}

/** Top-level property names of an `export interface <name> { ... }`, brace-matched. */
function interfaceKeys(source: string, name: string): string[] {
  const start = source.indexOf(`interface ${name}`)
  if (start === -1) return []
  const open = source.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++
    else if (source[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = source.slice(open + 1, end)
  const keys: string[] = []
  // Only depth-1 property declarations: `name?: ...` / `name: ...`.
  let d = 0
  for (const line of body.split('\n')) {
    const opens = (line.match(/\{/g) ?? []).length
    const closes = (line.match(/\}/g) ?? []).length
    const m = d === 0 ? line.match(/^\s*(\w+)\??\s*:/) : null
    if (m) keys.push(m[1]!)
    d += opens - closes
  }
  return keys
}

test.group('Docs integrity: crypto satellite page', () => {
  test('every registered crypto ace command is documented on the crypto page', ({ assert }) => {
    const page = doc()
    const commands = registeredCommands()
    assert.isAbove(commands.length, 0, 'expected to discover crypto command manifest entries')

    const undocumented = commands.filter((name) => !page.includes(name))
    assert.deepEqual(
      undocumented,
      [],
      `These crypto ace commands are not documented in docs/guides/satellites/crypto.md: ${undocumented.join(', ')}`
    )
  })

  test('every crypto config option is documented on the crypto page', ({ assert }) => {
    const page = doc()
    const src = readFileSync(DEFINE_CONFIG, 'utf8')
    const keys = [...interfaceKeys(src, 'CryptoConfig'), ...interfaceKeys(src, 'CryptoFieldConfig')]
    assert.includeMembers(
      keys,
      ['keyProvider', 'fields', 'erasabilityResolver'],
      'the CryptoConfig interface parse should surface its known options'
    )

    const undocumented = keys.filter((key) => !page.includes(key))
    assert.deepEqual(
      undocumented,
      [],
      `These crypto config options are declared but not documented in crypto.md: ${undocumented.join(', ')}`
    )
  })

  test('the crypto extension-contract surface is documented on the crypto page', ({ assert }) => {
    const page = doc()
    // The constant NAME hosts wire in a custom KeyProvider must appear in the guide.
    assert.include(
      page,
      'CRYPTO_CONTRACT_VERSION',
      'the crypto page must document CRYPTO_CONTRACT_VERSION (custom KeyProvider contract)'
    )
    // Sanity: the constant is actually exported at the value the guide describes.
    const src = readFileSync(CONTRACT_VERSION, 'utf8')
    assert.match(
      src,
      /CRYPTO_CONTRACT_VERSION\s*=\s*\d+/,
      'CRYPTO_CONTRACT_VERSION must be a numeric export'
    )
  })
})

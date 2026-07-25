import { test } from '@japa/runner'
import { existsSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'
import { CRYPTO_GUARD_REGISTRY } from '../../../src/isthmus/crypto_guard_registry.js'
import { CRYPTO_NO_SILENT_GUARD_ALLOWLIST } from '../../../src/isthmus/no_silent_crypto_guard_allowlist.js'

/**
 * No silent crypto guard: the satellite mirror of the kernel's / AI's scan. A
 * fail-closed rejection (detected by the "Refusing …" guard idiom adjacent to a
 * `throw`) must either belong to a registered crypto guard that emits, or carry a
 * written allowlist reason. Same detector shape as the kernel and AI specs so the
 * convention cannot drift: from each `throw new` line, look FORWARD up to 4 non-comment
 * lines for the "refus…" message.
 *
 * The second group pins the registry contract itself: guard files exist and emit,
 * every emit call in src references a registered id, ids and event names stay inside
 * the satellite-namespaced taxonomy, and evidence and review dates are real.
 */

const CRYPTO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const SRC_ROOT = join(CRYPTO_ROOT, 'src')

const THROW_LINE = /\bthrow new /
const REFUSAL = /refus/i
const WINDOW = 4

const REGISTERED_FILES = new Set<string>(CRYPTO_GUARD_REGISTRY.map((e) => e.guardFile))
const ALLOWED_FILES = new Set(CRYPTO_NO_SILENT_GUARD_ALLOWLIST.map((e) => e.path))

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
}

/** Line numbers (1-based) of fail-closed throw sites in a source text. */
export function refusalThrowSites(src: string): number[] {
  const lines = src.split('\n')
  const sites: number[] = []
  lines.forEach((line, i) => {
    if (isComment(line) || !THROW_LINE.test(line)) return
    const window = lines.slice(i, i + WINDOW + 1).filter((l) => !isComment(l))
    if (window.some((l) => REFUSAL.test(l))) sites.push(i + 1)
  })
  return sites
}

test.group('architectural: no silent crypto guard', () => {
  test('every refusal throw site is registered-and-emitting or allowlisted', ({ assert }) => {
    const violations: string[] = []
    for (const file of walkTsFiles(SRC_ROOT)) {
      const rel = relative(CRYPTO_ROOT, file).replace(/\\/g, '/')
      const src = readFileSync(file, 'utf8')
      const sites = refusalThrowSites(src)
      if (sites.length === 0) continue
      if (ALLOWED_FILES.has(rel)) continue
      if (REGISTERED_FILES.has(rel) && src.includes('emitCryptoGuardEvent(')) continue
      violations.push(`${rel}:${sites.join(',')}`)
    }
    assert.deepEqual(
      violations,
      [],
      [
        'Found fail-closed crypto guard(s) that reject silently. Either register the guard in',
        'CRYPTO_GUARD_REGISTRY (src/isthmus/crypto_guard_registry.ts) and emit before the throw,',
        'or add the file to CRYPTO_NO_SILENT_GUARD_ALLOWLIST with a written reason.',
        '',
        'Violations:',
        ...violations.map((v) => '  - ' + v),
      ].join('\n')
    )
  })

  test('the allowlist is not stale (paths exist and still contain a refusal site)', ({
    assert,
  }) => {
    for (const { path } of CRYPTO_NO_SILENT_GUARD_ALLOWLIST) {
      const full = join(CRYPTO_ROOT, path)
      assert.isTrue(existsSync(full), `allowlisted path no longer exists: ${path}`)
      const sites = refusalThrowSites(readFileSync(full, 'utf8'))
      assert.isAbove(sites.length, 0, `allowlisted path has no refusal site left: ${path}`)
    }
  })

  test('every allowlist entry carries a written reason', ({ assert }) => {
    for (const entry of CRYPTO_NO_SILENT_GUARD_ALLOWLIST) {
      assert.isAbove(
        entry.why.trim().length,
        20,
        `allowlist entry ${entry.path} needs a real reason, not a stub`
      )
    }
  })

  test('detector controls: flags refusal throws, ignores comments and plain errors', ({
    assert,
  }) => {
    const flagged = [
      `throw new CryptoException('shred_refused', 'refusing to shred: legal hold')`,
      [
        `throw new CryptoException(`,
        `  'tenant_scope_mismatch',`,
        `  'refusing a wrapped-DEK query'`,
        `)`,
      ].join('\n'),
    ]
    const clean = [
      `throw new CryptoException('dek_missing', '[crypto] no live DEK for this subject')`,
      [`// Refuse unless the caller explicitly overrides.`, `throw new Error('duplicate')`].join(
        '\n'
      ),
      [`throw new Error('duplicate')`, `// refuses to fall through`].join('\n'),
    ]
    for (const s of flagged) assert.isAbove(refusalThrowSites(s).length, 0, `should flag:\n${s}`)
    for (const s of clean) assert.lengthOf(refusalThrowSites(s), 0, `should NOT flag:\n${s}`)
  })
})

test.group('architectural: crypto guard registry contract', () => {
  test('every guardFile exists and contains an emit call for its id', ({ assert }) => {
    for (const entry of CRYPTO_GUARD_REGISTRY) {
      const full = join(CRYPTO_ROOT, entry.guardFile)
      assert.isTrue(existsSync(full), `${entry.id}: guardFile missing (${entry.guardFile})`)
      const src = readFileSync(full, 'utf8')
      assert.include(
        src,
        `emitCryptoGuardEvent('${entry.id}'`,
        `${entry.id}: guardFile never emits its own id`
      )
    }
  })

  test('every emit call in src references a registered id', ({ assert }) => {
    const ids = new Set<string>(CRYPTO_GUARD_REGISTRY.map((e) => e.id))
    const strays: string[] = []
    for (const file of walkTsFiles(SRC_ROOT)) {
      const src = readFileSync(file, 'utf8')
      for (const match of src.matchAll(/emitCryptoGuardEvent\(\s*'([^']+)'/g)) {
        if (!ids.has(match[1]!)) {
          strays.push(`${relative(CRYPTO_ROOT, file).replace(/\\/g, '/')}: ${match[1]}`)
        }
      }
    }
    assert.deepEqual(strays, [], `emit calls with unregistered ids:\n${strays.join('\n')}`)
  })

  test('ids and event names stay inside the satellite-namespaced taxonomy', ({ assert }) => {
    const seen = new Set<string>()
    for (const entry of CRYPTO_GUARD_REGISTRY) {
      assert.match(
        entry.id,
        /^guard\.crypto_[a-z_]+$/,
        `${entry.id}: id outside the crypto_ namespace`
      )
      assert.match(
        entry.event,
        /^isthmus:guard:crypto_[a-z_]+:rejected$/,
        `${entry.id}: event outside the documented taxonomy`
      )
      assert.isFalse(seen.has(entry.id), `duplicate id: ${entry.id}`)
      seen.add(entry.id)
    }
  })

  test('every entry carries real evidence and coherent review dates', ({ assert }) => {
    for (const entry of CRYPTO_GUARD_REGISTRY) {
      assert.isAbove(
        entry.evidence.ref.trim().length,
        20,
        `${entry.id}: evidence.ref needs a real reason, not a stub`
      )
      const reviewed = Date.parse(entry.reviewed)
      const nextReview = Date.parse(entry.nextReview)
      assert.isFalse(Number.isNaN(reviewed), `${entry.id}: reviewed does not parse`)
      assert.isFalse(Number.isNaN(nextReview), `${entry.id}: nextReview does not parse`)
      assert.isAbove(nextReview, reviewed, `${entry.id}: nextReview must be after reviewed`)
    }
  })
})

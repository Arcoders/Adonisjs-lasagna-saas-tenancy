import { test } from '@japa/runner'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { walkTsFiles } from '../../helpers/walk_ts_files.js'

/**
 * Anti-regression guard for WS-1's promise: every secret read/write goes through
 * the canonical, fail-closed, domain-separated accessor in `secret_at_rest.ts`
 * (`readSecret` / `writeSecret`). No module may call the raw crypto primitives
 * `encrypt(` / `decrypt(` / `decryptStrict(` on a secret seam directly, because:
 *
 *   - the lenient `decrypt(` passes a non-ciphertext value through unchanged, a
 *     silent fail-OPEN on a secret column (the SSO `client_secret` bug), and
 *   - calling `encrypt(`/`decryptStrict(` directly skips the per-class context,
 *     collapsing the HKDF domain separation back to a single shared key.
 *
 * `decryptWithAppKey(` (rotation/migration, explicit key + context) is NOT
 * flagged: the migration commands legitimately recover plaintext from any prior
 * key/context via it, and re-encrypt through `writeSecret`. `readSecret` /
 * `writeSecret` / `isEncrypted` are the safe paths and are never flagged.
 *
 * The walk covers EVERY `packages/<pkg>/src`, so a satellite that grows a secret
 * column is held to the same seam without editing this spec.
 */

const PACKAGES_DIR = fileURLToPath(new URL('../../../../', import.meta.url))

// Files permitted to call the raw primitives, one entry per path with its reason.
const ALLOWLIST: ReadonlyArray<{ path: string; why: string }> = [
  { path: 'core/src/utils/crypto.ts', why: 'defines the primitives themselves' },
  {
    path: 'core/src/utils/secret_at_rest.ts',
    why: 'the canonical accessor; the one place encrypt/decryptStrict are bound to a class context',
  },
]
const ALLOWED_PATHS = new Set(ALLOWLIST.map((e) => e.path))

// Per-line escape hatch, used sparingly with a justification.
const ALLOWED_OPT_OUT = /\/\/\s*secret-crypto-ok:/i

// Matches a call to encrypt(, decrypt(, or decryptStrict(, but not
// decryptWithAppKey( (its next char after "decrypt" is "W", so the `decrypt`
// alternative can't reach a `(`), nor readSecret/writeSecret/isEncrypted.
const PRIMITIVE_CALL = /\b(?:encrypt|decrypt|decryptStrict)\s*\(/

function srcRoots(): string[] {
  const roots: string[] = []
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, entry, 'src')
    if (existsSync(src) && statSync(src).isDirectory()) roots.push(src)
  }
  return roots
}

function isComment(line: string): boolean {
  const t = line.trim()
  return t.startsWith('*') || t.startsWith('//') || t.startsWith('/*')
}

test.group('Architectural: secret crypto must route through the canonical accessor', () => {
  test('no module calls encrypt/decrypt/decryptStrict directly outside the allowlist', ({
    assert,
  }) => {
    const violations: string[] = []

    for (const root of srcRoots()) {
      for (const file of walkTsFiles(root)) {
        const rel = relative(PACKAGES_DIR, file).replace(/\\/g, '/')
        if (ALLOWED_PATHS.has(rel)) continue

        const src = readFileSync(file, 'utf8')
        if (!PRIMITIVE_CALL.test(src)) continue

        const lines = src.split('\n')
        lines.forEach((line, i) => {
          if (isComment(line) || !PRIMITIVE_CALL.test(line)) return
          const window = lines.slice(Math.max(0, i - 1), i + 2)
          if (window.some((l) => ALLOWED_OPT_OUT.test(l))) return
          violations.push(`${rel}:${i + 1} — ${line.trim().slice(0, 100)}`)
        })
      }
    }

    assert.deepEqual(
      violations,
      [],
      [
        'Found a direct encrypt/decrypt/decryptStrict call on a secret seam. Route it',
        'through readSecret/writeSecret (utils/secret_at_rest.ts) so the read is fail-closed',
        'and the value is bound to its per-class context. If this is genuinely the accessor',
        'or a bounded migration, add the path to ALLOWLIST or annotate the line with',
        '`// secret-crypto-ok: <reason>`.',
        '',
        'Violations:',
        ...violations.map((v) => '  - ' + v),
      ].join('\n')
    )
  })

  test('the allowlisted accessor and primitive definitions exist (allowlist is not stale)', ({
    assert,
  }) => {
    for (const { path } of ALLOWLIST) {
      assert.isTrue(
        existsSync(join(PACKAGES_DIR, path)),
        `allowlisted path no longer exists: ${path}`
      )
    }
  })

  test('the detector flags the dangerous calls and ignores the safe ones (controls)', ({
    assert,
  }) => {
    const flagged = [
      `return encrypt(plain, ctx)`,
      `const v = decrypt(stored)`,
      `const v = decryptStrict(stored, ctx)`,
    ]
    const clean = [
      `return writeSecret(plain, 'webhookSecret')`,
      `const v = readSecret(stored, 'ssoClientSecret')`,
      `decryptWithAppKey(value, oldKey, ctx)`,
      `if (isEncrypted(value)) {`,
    ]
    for (const s of flagged) assert.isTrue(PRIMITIVE_CALL.test(s), `should flag: ${s}`)
    for (const s of clean) assert.isFalse(PRIMITIVE_CALL.test(s), `should NOT flag: ${s}`)
  })
})

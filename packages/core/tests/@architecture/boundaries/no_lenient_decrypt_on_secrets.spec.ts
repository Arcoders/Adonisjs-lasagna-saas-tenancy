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
 * The detector targets a BARE call to the core primitive (`encrypt(value, ctx)`)
 * — a value-passing call from a module that imported it. It does NOT flag a
 * receiver-qualified method call (`repo.encrypt(...)`) or a method DEFINITION
 * with a first typed param (`encrypt(subject: SubjectId, …)`): those are a
 * satellite's OWN field-encryption seam (the crypto satellite's
 * `EncryptedRepository`, a per-(subject,category) DEK abstraction that is NOT the
 * core app-key secret seam), a different `encrypt`/`decrypt` the core guard has
 * no business policing.
 *
 * The walk covers EVERY `packages/<pkg>/src` AND the reference app
 * (`examples/api/app`), so a satellite that grows a secret column, OR the demo
 * that hosts copy, is held to the same seam without editing this spec. (The demo
 * once wrote a webhook secret with a bare `encrypt()`, which used the default
 * context and silently failed the per-class read at delivery; scanning it keeps
 * that footgun from coming back into the code people copy.)
 */

const REPO_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url))
const PACKAGES_DIR = join(REPO_ROOT, 'packages')
// The reference app is held to the same secret seam as the packages.
const EXAMPLE_APP_DIRS = [join(REPO_ROOT, 'examples', 'api', 'app')]

// Files permitted to call the raw primitives, one entry per path with its reason.
const ALLOWLIST: ReadonlyArray<{ path: string; why: string }> = [
  { path: 'packages/core/src/utils/crypto.ts', why: 'defines the primitives themselves' },
  {
    path: 'packages/core/src/utils/secret_at_rest.ts',
    why: 'the canonical accessor; the one place encrypt/decryptStrict are bound to a class context',
  },
]
const ALLOWED_PATHS = new Set(ALLOWLIST.map((e) => e.path))

// Per-line escape hatch, used sparingly with a justification.
const ALLOWED_OPT_OUT = /\/\/\s*secret-crypto-ok:/i

// Matches a BARE call to the core secret primitives encrypt(, decrypt(, or
// decryptStrict(, but NOT:
//   - decryptWithAppKey( (its next char after "decrypt" is "W", so the `decrypt`
//     alternative can't reach a `(`), nor readSecret/writeSecret/isEncrypted;
//   - a receiver-qualified member call `X.encrypt(` — the `(?<![.\w])` lookbehind
//     rejects a preceding `.` (or word char), so a satellite's own
//     `repo.encrypt(...)` field-crypto seam is not a false positive;
//   - a method DEFINITION `encrypt(subject: SubjectId, …)` — the
//     `(?!\s*\w+\s*:)` lookahead rejects a first TYPED param, which only a
//     declaration has (a value-passing call to the core primitive never does).
const PRIMITIVE_CALL = /(?<![.\w])(?:encrypt|decrypt|decryptStrict)\s*\((?!\s*\w+\s*:)/

function srcRoots(): string[] {
  const roots: string[] = []
  for (const entry of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, entry, 'src')
    if (existsSync(src) && statSync(src).isDirectory()) roots.push(src)
  }
  for (const dir of EXAMPLE_APP_DIRS) {
    if (existsSync(dir) && statSync(dir).isDirectory()) roots.push(dir)
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
        const rel = relative(REPO_ROOT, file).replace(/\\/g, '/')
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
      assert.isTrue(existsSync(join(REPO_ROOT, path)), `allowlisted path no longer exists: ${path}`)
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
      // A satellite's own field-crypto seam: receiver-qualified member calls and
      // typed-param method definitions are a different encrypt/decrypt, not the
      // core secret primitive. (crypto's EncryptedRepository — the false positives
      // this tightening removes.)
      `model.$setAttribute(f.column, await repo.encrypt(f.subject(model), f.category, value))`,
      `const plain = await repo.decrypt(subject, category, ciphertext)`,
      `async encrypt(subject: SubjectId, category: CategoryKey, value: string): Promise<string> {`,
      `async decrypt(subject: SubjectId, category: CategoryKey, ciphertext: string): Promise<string> {`,
    ]
    for (const s of flagged) assert.isTrue(PRIMITIVE_CALL.test(s), `should flag: ${s}`)
    for (const s of clean) assert.isFalse(PRIMITIVE_CALL.test(s), `should NOT flag: ${s}`)
  })
})

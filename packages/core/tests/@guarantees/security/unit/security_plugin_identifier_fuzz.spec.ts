import { test } from '@japa/runner'
import {
  pluginName,
  authorizerName,
  middlewareName,
  macroName,
  capabilityKey,
} from '../../../../src/sdk/brands.js'
import { __resetIsthmusCounters, snapshotIsthmusCounters } from '../../../../src/isthmus/audit.js'

/**
 * Identifier fuzz: the branded-name minters are the plugin surface's proof-of-safety.
 * A value of type PluginName / AuthorizerName / MiddlewareName / MacroName /
 * CapabilityKey EXISTS only because it passed `assertSafeIdentifier` at mint time
 * (see brands.ts: `mint()` is the ONE sanctioned assertion site). So anything an
 * author later interpolates into a Redis key, a BullMQ jobId, a `Symbol`, or raw
 * DDL takes a branded parameter, and a raw string that skipped the guard cannot
 * reach that slot.
 *
 * This spec drives a hostile identifier corpus through EVERY minter and asserts
 * each REJECTS it, so a key-delimiter, a DDL escape, a statement terminator,
 * path traversal, a shell metacharacter, over-length, or a homoglyph that NFKC
 * would fold onto an ASCII id can never be minted into a brand. The guard's OWN
 * corpus is exercised in behavior_identifier.spec.ts; this pins that every plugin
 * minter is actually wired to it (a future minter that forgot to call the guard
 * would light up here).
 */

/** Every branded-name minter on the plugin surface, by the kind it guards. */
const MINTERS = [
  { kind: 'plugin name', mint: pluginName },
  { kind: 'authorizer name', mint: authorizerName },
  { kind: 'middleware name', mint: middlewareName },
  { kind: 'macro name', mint: macroName },
  { kind: 'capability key', mint: capabilityKey },
] as const

/**
 * Hostile identifiers spanning the Redis-key delimiter, PG identifier escapes,
 * statement injection, path traversal, shell metacharacters, whitespace, length,
 * emptiness, and non-canonical unicode. Mirrors the assertSafeIdentifier corpus
 * so the minters are proven to reject exactly what the guard rejects.
 */
const HOSTILE = [
  'a:b', // Redis metric / rate-limit key delimiter
  'victim:2026-06-28:requests', // forged key structure (another tenant's row)
  'a"b', // PG identifier escape
  'a; DROP DATABASE postgres; --', // statement terminator
  'a b', // whitespace
  'a\nb', // newline
  'a/b', // path separator
  '../etc/passwd', // traversal
  'a\\b', // backslash
  'a|b', // shell pipe
  'a&b', // shell background
  'a$(rm -rf /)', // command substitution
  '*', // glob wildcard
  '', // empty
  'a'.repeat(64), // over the PG NAMEDATALEN-1 (63) limit
  'tenant_℀', // U+2100, NFKC folds toward "a/c"
  '\u{1D538}', // 𝔸 folds to ASCII "A"
  '１２３', // fullwidth digits fold to 123
  'á', // "a" + combining acute accent (non-canonical form)
] as const

/**
 * Legitimate ids EVERY minter must ACCEPT. The control that keeps the fuzz honest:
 * without it a minter that rejected literally everything would pass vacuously.
 */
const SAFE = ['acme', 'Tenant_42', 'a-b-c', '11111111-1111-4111-8111-111111111111'] as const

test.group('plugin minters — hostile identifier fuzz (a brand is proof of safety)', () => {
  test('the corpus and the minter set are non-trivial', ({ assert }) => {
    assert.isAbove(HOSTILE.length, 15)
    assert.equal(MINTERS.length, 5)
  })

  for (const { kind, mint } of MINTERS) {
    test(`${kind}: rejects every hostile identifier`, ({ assert }) => {
      for (const bad of HOSTILE) {
        // Each throws the "unsafe" mint error before minting the brand.
        let threw = false
        try {
          mint(bad)
        } catch {
          threw = true
        }
        assert.isTrue(threw, `${kind} must reject ${JSON.stringify(bad)}`)
      }
    })

    test(`${kind}: mints every legitimate identifier`, ({ assert }) => {
      for (const ok of SAFE) {
        assert.doesNotThrow(() => mint(ok), `${kind} must accept ${JSON.stringify(ok)}`)
      }
    })
  }

  test('a rejected mint trips the guard.plugin_extension_identifier counter (observable)', ({
    assert,
  }) => {
    __resetIsthmusCounters()
    assert.throws(() => authorizerName('a:b'))
    // The plugin surface emits its OWN guard, distinct from guard.tenant_identifier
    // (a hostile plugin name is a different signal from a bad tenant id).
    const rejected = snapshotIsthmusCounters().rejected.find(
      (r) => r.id === 'guard.plugin_extension_identifier'
    )
    assert.isDefined(rejected)
    assert.isAbove(rejected?.value ?? 0, 0)
  })
})

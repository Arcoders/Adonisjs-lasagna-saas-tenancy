import { test } from '@japa/runner'
import { classifyRelocation } from '../../../../src/services/doctor/tenant_ledger_reconcile.js'
import type { ResolvedMigrationAlias } from '../../../../src/sdk/configure_kit.js'

/**
 * Part D unit tier — one case per PURE reconcile gate (source membership + alias
 * authority + normalization). The SQL gates (multiplicity, physical existence,
 * fingerprint equality, the transaction) are exercised in the resilience integration
 * tier and the fault-injection chaos tier against real Postgres.
 */
const FROM = 'database/migrations/tenant/0013_create_x'
const TO = '../../packages/x/build/tenant_migrations/1751_create_x'

const aliasMap = (from = FROM, to = TO): Map<string, ResolvedMigrationAlias> =>
  new Map([[to, { from, to, ownerPackage: '@x/x', ownerSlug: 'x' }]])

const source = (...names: string[]) => new Set(names)

test.group('classifyRelocation — pure reconcile pre-gates', () => {
  test('accepts a declared, owned pair with to in source and from not in source', ({ assert }) => {
    const v = classifyRelocation(FROM, TO, source(TO), aliasMap())
    assert.isTrue(v.ok)
  })

  test('refuses from === to', ({ assert }) => {
    const v = classifyRelocation(TO, TO, source(TO), aliasMap(TO, TO))
    assert.deepEqual(v, { ok: false, reason: 'from_equals_to' })
  })

  test('refuses a to that is not in the source tree', ({ assert }) => {
    const v = classifyRelocation(FROM, TO, source('something_else'), aliasMap())
    assert.deepEqual(v, { ok: false, reason: 'to_not_in_source' })
  })

  test('refuses a from that is STILL a live source migration', ({ assert }) => {
    // A `from` still present in the source is a live migration and must never be rewritten.
    const v = classifyRelocation(FROM, TO, source(TO, FROM), aliasMap())
    assert.deepEqual(v, { ok: false, reason: 'from_still_in_source' })
  })

  test('refuses a to with no alias authority', ({ assert }) => {
    const v = classifyRelocation(FROM, TO, source(TO), new Map())
    assert.deepEqual(v, { ok: false, reason: 'no_alias_authority' })
  })

  test('refuses when the alias declares a different from (no heuristic pairing)', ({ assert }) => {
    const v = classifyRelocation(
      FROM,
      TO,
      source(TO),
      aliasMap('database/migrations/tenant/0099_other')
    )
    assert.deepEqual(v, { ok: false, reason: 'alias_from_mismatch' })
  })

  test('matches under NFC normalization (a decomposed ledger name still pairs)', ({ assert }) => {
    // Composed "e-acute" (U+00E9) vs decomposed ("e" + combining acute U+0301) must
    // compare equal once both are NFC-normalized. Built by code point so no source-file
    // encoding can collapse the two forms before the test runs.
    const eAcute = String.fromCodePoint(0x00e9)
    const eCombining = 'e' + String.fromCodePoint(0x0301)
    const composed = `database/migrations/tenant/0013_caf${eAcute}`
    const decomposed = `database/migrations/tenant/0013_caf${eCombining}`
    assert.notEqual(
      composed,
      decomposed,
      'the two encodings are byte-distinct before normalization'
    )
    const v = classifyRelocation(decomposed, TO, source(TO), aliasMap(composed))
    assert.isTrue(v.ok, 'NFC-normalized from matches the composed alias declaration')
  })
})

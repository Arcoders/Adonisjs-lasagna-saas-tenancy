import { test } from '@japa/runner'
import {
  canonicalizeToolArgs,
  deriveAiToolConfirmationMacKey,
  hashToolArgs,
  mintToolConfirmation,
  parseToolConfirmationHeader,
  verifyToolConfirmation,
  type ToolConfirmationBinding,
} from '../../../../src/gateway/tool_confirmation.js'
import {
  AI_TOOL_CONFIRMATION_TOKEN_MAX_LENGTH,
  MAX_TOOL_CONFIRMATIONS_PER_REQUEST,
  TOOL_CONFIRMATION_TTL_MS,
} from '../../../../src/constants.js'

/**
 * The Phase 3a confirmation token: a bearer capability for exactly one mutation.
 *
 * The property these specs are built around is that the token carries no claims.
 * Verification re-derives every bound field from the request being served and reads
 * only `jti` and `exp` off the wire, so a token for another tenant, principal, tool
 * or set of arguments does not fail a check, it simply is not the same value. Each
 * test below therefore tries to SPEND a token somewhere it should not work, rather
 * than asserting on the token's internals.
 */

const KEY = deriveAiToolConfirmationMacKey('app-key-for-confirmation-specs-0000!')
const OTHER_KEY = deriveAiToolConfirmationMacKey('a-different-app-key-entirely-0000!')

const BINDING: ToolConfirmationBinding = {
  tenantId: 'tenant-a',
  principalHash: 'principal-hash-1',
  toolName: 'cancel_booking',
  argsHash: hashToolArgs({ bookingId: 'BK-1' }),
}

const NOW = 1_700_000_000_000

/** The binding with one field swapped, the shape every cross-boundary test needs. */
const withField = (patch: Partial<ToolConfirmationBinding>): ToolConfirmationBinding => ({
  ...BINDING,
  ...patch,
})

test.group('Phase 3a confirmation token', () => {
  test('a token minted for a binding authorizes that exact binding', ({ assert }) => {
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    const found = verifyToolConfirmation(KEY, [minted.token], BINDING, NOW + 1_000)

    assert.isNotNull(found)
    assert.equal(found?.effectKey, minted.effectKey)
    assert.equal(found?.jti, minted.jti)
  })

  test('the token binds the tenant: another tenant cannot spend it', ({ assert }) => {
    // The confused-deputy shape. Not a check that rejects, a MAC that differs.
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    assert.isNull(
      verifyToolConfirmation(KEY, [minted.token], withField({ tenantId: 'tenant-b' }), NOW + 1_000)
    )
  })

  test('the token binds the principal: another user cannot spend it', ({ assert }) => {
    // Why a resolvable principal is mandatory for action tools: a confirmation that
    // bound to nobody would be spendable by any session holding the string.
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    assert.isNull(
      verifyToolConfirmation(
        KEY,
        [minted.token],
        withField({ principalHash: 'principal-hash-2' }),
        NOW + 1_000
      )
    )
  })

  test('the token binds the tool: a confirmation for one action cannot fire another', ({
    assert,
  }) => {
    // The human said yes to cancelling a booking, not to deleting a fleet.
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    assert.isNull(
      verifyToolConfirmation(KEY, [minted.token], withField({ toolName: 'delete_fleet' }), NOW + 1)
    )
  })

  test('the token binds the arguments: the model cannot swap the target after the human agreed', ({
    assert,
  }) => {
    // The propose-A-confirm-B attack, and the reason argsHash is in the MAC at all.
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    assert.isNull(
      verifyToolConfirmation(
        KEY,
        [minted.token],
        withField({ argsHash: hashToolArgs({ bookingId: 'BK-999' }) }),
        NOW + 1_000
      )
    )
  })

  test('a token is dead once its TTL passes', ({ assert }) => {
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    assert.isNotNull(verifyToolConfirmation(KEY, [minted.token], BINDING, NOW + 1))
    // The lifetime IS the revocation: a bearer token cannot be recalled.
    assert.isNull(
      verifyToolConfirmation(KEY, [minted.token], BINDING, NOW + TOOL_CONFIRMATION_TTL_MS + 1)
    )
  })

  test('a token minted under a different APP_KEY never verifies', ({ assert }) => {
    // A forged token, and the APP_KEY rotation case: old capabilities die.
    const forged = mintToolConfirmation(OTHER_KEY, BINDING, NOW)
    assert.isNull(verifyToolConfirmation(KEY, [forged.token], BINDING, NOW + 1_000))
  })

  test('tampering with the expiry to extend a token invalidates it', ({ assert }) => {
    // exp travels in the clear BECAUSE it is a MAC input. Editing it is self-defeating.
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    const [prefix, jti, , mac] = minted.token.split('.')
    const extended = [prefix, jti, String(NOW + 10 * TOOL_CONFIRMATION_TTL_MS), mac].join('.')

    assert.isNull(verifyToolConfirmation(KEY, [extended], BINDING, NOW + 1_000))
  })

  test('every mint is distinct, so one token means one effect', ({ assert }) => {
    // effectKey is the TOKEN's MAC, not the binding's hash. Two deliberate repeats of
    // the same action get different keys, so the ledger cannot swallow the second as
    // a replay. This is the property that keeps at-most-once from becoming at-most-ever.
    const first = mintToolConfirmation(KEY, BINDING, NOW)
    const second = mintToolConfirmation(KEY, BINDING, NOW)

    assert.notEqual(first.jti, second.jti)
    assert.notEqual(
      first.effectKey,
      second.effectKey,
      'the same action twice needs two effect keys'
    )
    assert.isNotNull(verifyToolConfirmation(KEY, [second.token], BINDING, NOW + 1))
  })

  test('the token names nothing: no bound field appears on the wire', ({ assert }) => {
    // A token in an access log must not identify the tenant, the user, or the action.
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    assert.notInclude(minted.token, BINDING.tenantId)
    assert.notInclude(minted.token, BINDING.principalHash)
    assert.notInclude(minted.token, BINDING.toolName)
    assert.notInclude(minted.token, BINDING.argsHash)
  })

  test('the right token is found among stale and malformed ones', ({ assert }) => {
    // Real client behaviour across a multi-step conversation: old tokens linger.
    const minted = mintToolConfirmation(KEY, BINDING, NOW)
    const stale = mintToolConfirmation(KEY, withField({ toolName: 'other_tool' }), NOW)

    const found = verifyToolConfirmation(
      KEY,
      ['not-a-token', stale.token, minted.token],
      BINDING,
      NOW + 1_000
    )
    assert.equal(found?.effectKey, minted.effectKey)
  })

  test('a garbage token is never an exception', ({ assert }) => {
    // This sits on a mutation path, so a malformed input must not become a 500.
    for (const junk of ['', '.', 'aitc1', 'aitc1.a.b.c', 'aitc1..0.mac', 'x'.repeat(5_000)]) {
      assert.isNull(
        verifyToolConfirmation(KEY, [junk], BINDING, NOW),
        `threw or matched on ${junk}`
      )
    }
  })
})

test.group('Phase 3a confirmation header parsing', () => {
  test('reads a comma-separated list and a repeated header alike', ({ assert }) => {
    assert.deepEqual(parseToolConfirmationHeader('a,b'), ['a', 'b'])
    assert.deepEqual(parseToolConfirmationHeader(['a', 'b']), ['a', 'b'])
    assert.deepEqual(parseToolConfirmationHeader(undefined), [])
  })

  test('drops malformed entries instead of failing the request', ({ assert }) => {
    // A stale or mangled token beside a good one is a cosmetic client bug. Rejecting
    // the whole request for it would turn that into a dead mutation path; dropping it
    // lands in the same place as never sending it.
    const long = 'x'.repeat(AI_TOOL_CONFIRMATION_TOKEN_MAX_LENGTH + 1)
    assert.deepEqual(parseToolConfirmationHeader(`good,${long},  ,ok`), ['good', 'ok'])
    assert.deepEqual(parseToolConfirmationHeader('with space'), [])
  })

  test('accepts at most one round worth of tokens', ({ assert }) => {
    // A round cannot need more confirmations than it is allowed calls, so anything
    // beyond that is a client bug or someone spraying tokens at the MAC.
    const many = Array.from({ length: MAX_TOOL_CONFIRMATIONS_PER_REQUEST + 5 }, (_, i) => `t${i}`)
    assert.lengthOf(parseToolConfirmationHeader(many.join(',')), MAX_TOOL_CONFIRMATIONS_PER_REQUEST)
  })
})

test.group('Phase 3a argument canonicalization', () => {
  test('key order does not change the hash', ({ assert }) => {
    // The load-bearing one. The model re-proposes on the confirming turn and JSON key
    // order does not survive that round trip, so an order-sensitive hash would make
    // confirmation fail at random and the feature would read as broken.
    assert.equal(hashToolArgs({ a: 1, b: 2 }), hashToolArgs({ b: 2, a: 1 }))
    assert.equal(
      hashToolArgs({ outer: { x: 1, y: 2 }, z: 3 }),
      hashToolArgs({ z: 3, outer: { y: 2, x: 1 } })
    )
  })

  test('array order DOES change the hash, because order is meaning', ({ assert }) => {
    assert.notEqual(hashToolArgs({ ids: ['a', 'b'] }), hashToolArgs({ ids: ['b', 'a'] }))
  })

  test('different values hash differently', ({ assert }) => {
    assert.notEqual(hashToolArgs({ id: 'BK-1' }), hashToolArgs({ id: 'BK-2' }))
    // A type change must not collide with its string form.
    assert.notEqual(hashToolArgs({ n: 1 }), hashToolArgs({ n: '1' }))
    // Nor may a value bleed across a key boundary.
    assert.notEqual(hashToolArgs({ a: 'x', b: 'y' }), hashToolArgs({ a: 'xy', b: '' }))
  })

  test('a cyclic or absurdly deep object is bounded, not a hang', ({ assert }) => {
    // This runs inside the single pump. A hostile shape must not be the thing that
    // stops the process.
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    assert.isString(canonicalizeToolArgs(cyclic))

    let deep: Record<string, unknown> = { end: true }
    for (let i = 0; i < 50; i++) deep = { nest: deep }
    assert.isString(canonicalizeToolArgs(deep))
  })
})

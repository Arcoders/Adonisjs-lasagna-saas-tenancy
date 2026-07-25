import { test } from '@japa/runner'
import {
  boundedFragmentGate,
  composeRedactionGate,
  type RedactionStats,
} from '../../../../src/gateway/ai_chat_controller.js'
import { assertAiConfig } from '../../../../src/validate_config.js'
import { AI_FRAGMENT_MAX_CHARS } from '../../../../src/constants.js'
import type { StreamFragment } from '../../../../src/types/ai_provider_contract.js'
import type { RedactOutput } from '../../../../src/define_config.js'

/**
 * The optional host `redactOutput` seam (LLM05 / LLM02).
 * The composed gate applies the mandatory output bound FIRST and LAST, so the bound
 * always holds; the host redactor sits between as defense-in-depth, NEVER the
 * isolation control. Fail-closed on throw / non-string; `null` aborts; `tokens`
 * preserved. These are pure-function proofs (Tier 1); the replay/memory coherence
 * lives in the integration tier.
 */

const frag = (data: string, tokens = 1): StreamFragment => ({ data, tokens })
const ctx = {} as any
const tenant = { id: 't1' } as any

function gate(redact: RedactOutput | undefined, stats: RedactionStats) {
  return composeRedactionGate(boundedFragmentGate, redact, ctx, tenant, stats)
}

test.group('security: redactOutput composed gate', () => {
  test('no hook: byte-identical to the mandatory bound (pass under, null over)', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate(undefined, stats)
    const ok = frag('hello')
    assert.strictEqual(g(ok), ok, 'under bound: same fragment reference passes')
    assert.isNull(g(frag('x'.repeat(AI_FRAGMENT_MAX_CHARS + 1))), 'over bound: aborts')
    assert.equal(stats.redactions, 0, 'no hook means no redaction accounting')
  })

  test('transforms: data replaced, tokens preserved, redaction counted', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate((_c, _t, chunk) => chunk.replace('SECRET', '[redacted]'), stats)
    const out = g(frag('my SECRET value', 7))
    assert.isNotNull(out)
    assert.equal(out!.data, 'my [redacted] value')
    assert.equal(out!.tokens, 7, 'tokens unchanged: provider cost is not refunded by redaction')
    assert.equal(stats.redactions, 1)
  })

  test('returns null: deliberate host abort, counted', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate(() => null, stats)
    assert.isNull(g(frag('anything')))
    assert.equal(stats.redactions, 1)
  })

  test('throws: fail-closed abort, no throw escapes, counted', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate(() => {
      throw new Error('DLP backend exploded')
    }, stats)
    let out: StreamFragment | null = frag('unredacted')
    assert.doesNotThrow(() => {
      out = g(frag('unredacted'))
    })
    assert.isNull(out, 'a throwing redactor aborts rather than emitting unredacted bytes')
    assert.equal(stats.redactions, 1)
  })

  test('non-string return: defensive fail-closed abort, counted', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate(() => 123 as any, stats)
    assert.isNull(g(frag('data')))
    assert.equal(stats.redactions, 1)
  })

  test('oversized redaction: the mandatory bound is re-applied and aborts', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate(() => 'y'.repeat(AI_FRAGMENT_MAX_CHARS + 1), stats)
    assert.isNull(g(frag('small')), 'a hook that expands past the bound cannot bypass I8')
    assert.equal(stats.redactions, 1)
  })

  test('oversized ORIGINAL fragment: bound fires first, redactor never called', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    let called = false
    const g = gate((_c, _t, chunk) => {
      called = true
      return chunk
    }, stats)
    assert.isNull(g(frag('z'.repeat(AI_FRAGMENT_MAX_CHARS + 1))))
    assert.isFalse(
      called,
      'the I8 bound is the floor; the host hook never sees an over-bound chunk'
    )
    assert.equal(stats.redactions, 0)
  })

  test('unchanged text: passes through, NOT counted as a redaction', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate((_c, _t, chunk) => chunk, stats)
    const f = frag('nothing to redact')
    const out = g(f)
    assert.isNotNull(out)
    assert.equal(out!.data, 'nothing to redact')
    assert.equal(stats.redactions, 0)
  })

  test('empty-string redaction: valid (fully redacted chunk), counted', ({ assert }) => {
    const stats: RedactionStats = { redactions: 0 }
    const g = gate(() => '', stats)
    const out = g(frag('sensitive'))
    assert.isNotNull(out)
    assert.equal(out!.data, '')
    assert.equal(stats.redactions, 1)
  })
})

test.group('security: redactOutput config validation', () => {
  const base = {
    allowedProviders: ['claude'],
    defaultProvider: 'claude',
    claude: { apiKey: 'sk-test' },
  }

  test('a function redactOutput is accepted', ({ assert }) => {
    assert.doesNotThrow(() =>
      assertAiConfig({
        ...base,
        redactOutput: ((_c, _t, chunk) => chunk) as RedactOutput,
      } as any)
    )
  })

  test('an absent redactOutput is accepted', ({ assert }) => {
    assert.doesNotThrow(() => assertAiConfig({ ...base } as any))
  })

  test('a non-function redactOutput throws at boot', ({ assert }) => {
    assert.throws(
      () => assertAiConfig({ ...base, redactOutput: 'nope' } as any),
      /redactOutput, when set, must be a function/
    )
  })
})

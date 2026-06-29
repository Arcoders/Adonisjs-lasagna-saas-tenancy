import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { signWebhookPayload } from '../../../../src/testing/sign_webhook_payload.js'

/**
 * `signWebhookPayload` mirrors the format Stripe ships in the
 * `stripe-signature` header. Unit-level tests here are independent of
 * MockStripe — they verify the actual HMAC bytes, so a future refactor
 * that breaks the helper is caught even if MockStripe's lenient
 * verification masks it.
 */
test.group('signWebhookPayload — HMAC format & tamper detection', () => {
  function recompute(timestamp: number, body: string, secret: string): string {
    return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  }

  test('produces the documented `t=<unix>,v1=<hex>` shape', ({ assert }) => {
    const sig = signWebhookPayload('{"a":1}', 'whsec_x', 1_700_000_000)
    assert.match(sig, /^t=1700000000,v1=[a-f0-9]{64}$/)
  })

  test('hex matches HMAC-SHA256 of `<timestamp>.<body>` with the given secret', ({ assert }) => {
    const body = '{"hello":"world"}'
    const ts = 1_700_000_000
    const sig = signWebhookPayload(body, 'whsec_secret', ts)
    const v1 = sig.split('v1=')[1]
    const expected = recompute(ts, body, 'whsec_secret')
    assert.equal(v1, expected)
  })

  test('different secrets produce different signatures for the same body', ({ assert }) => {
    const body = '{}'
    const ts = 1_700_000_000
    const a = signWebhookPayload(body, 'whsec_a', ts)
    const b = signWebhookPayload(body, 'whsec_b', ts)
    assert.notEqual(a, b)
  })

  test('tampered body breaks signature equivalence (the original v1 no longer matches)', ({
    assert,
  }) => {
    const ts = 1_700_000_000
    const original = '{"event_id":"evt_a","attempts":1}'
    const sig = signWebhookPayload(original, 'whsec_secret', ts)
    const v1 = sig.split('v1=')[1]

    // Attacker replaces "attempts:1" with "attempts:99" — recomputed HMAC
    // over the tampered body is not the same as the original v1.
    const tampered = original.replace('attempts":1', 'attempts":99')
    const recomputed = recompute(ts, tampered, 'whsec_secret')
    assert.notEqual(v1, recomputed, 'tampered body must not preserve the signature')
  })

  test('Buffer body works the same as string body', ({ assert }) => {
    const body = '{"k":1}'
    const ts = 1_700_000_000
    const fromString = signWebhookPayload(body, 'whsec_x', ts)
    const fromBuffer = signWebhookPayload(Buffer.from(body, 'utf8'), 'whsec_x', ts)
    assert.equal(fromString, fromBuffer)
  })

  test('default timestamp is "now" (within tolerance)', ({ assert }) => {
    const before = Math.floor(Date.now() / 1000)
    const sig = signWebhookPayload('{}', 'whsec_x')
    const after = Math.floor(Date.now() / 1000)
    const t = Number(sig.match(/^t=(\d+)/)![1])
    assert.isAtLeast(t, before)
    assert.isAtMost(t, after + 1)
  })
})

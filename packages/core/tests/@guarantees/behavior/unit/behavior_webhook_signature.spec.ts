import { test } from '@japa/runner'
import { createHmac } from 'node:crypto'
import { verifyWebhookSignature } from '../../../../src/services/webhook_service.js'

const SECRET = 'whsec_test_secret'

function sign(body: string | Buffer, secret = SECRET): string {
  return createHmac('sha256', secret).update(body).digest('hex')
}

test.group('verifyWebhookSignature', () => {
  test('accepts a correct signature over a string body', ({ assert }) => {
    const body = JSON.stringify({ event: 'tenant.created', id: 't1' })
    assert.isTrue(verifyWebhookSignature(body, sign(body), SECRET))
  })

  test('accepts a correct signature over a Buffer body (exact wire bytes)', ({ assert }) => {
    const body = Buffer.from('{"a":1}', 'utf8')
    assert.isTrue(verifyWebhookSignature(body, sign(body), SECRET))
  })

  test('rejects a signature produced with a different secret', ({ assert }) => {
    const body = '{"a":1}'
    assert.isFalse(verifyWebhookSignature(body, sign(body, 'other_secret'), SECRET))
  })

  test('rejects when the body was tampered after signing', ({ assert }) => {
    const sig = sign('{"a":1}')
    assert.isFalse(verifyWebhookSignature('{"a":2}', sig, SECRET))
  })

  test('rejects a missing signature header', ({ assert }) => {
    const body = '{"a":1}'
    assert.isFalse(verifyWebhookSignature(body, null, SECRET))
    assert.isFalse(verifyWebhookSignature(body, undefined, SECRET))
    assert.isFalse(verifyWebhookSignature(body, '', SECRET))
  })

  test('rejects a header of the wrong length without throwing', ({ assert }) => {
    // A short/long hex string must not reach timingSafeEqual (which throws on
    // length mismatch); the length guard returns false first.
    assert.isFalse(verifyWebhookSignature('{"a":1}', 'deadbeef', SECRET))
    assert.isFalse(verifyWebhookSignature('{"a":1}', 'f'.repeat(128), SECRET))
  })

  test('rejects a malformed (non-hex) header of correct length without throwing', ({ assert }) => {
    // 64 chars but not valid hex: Buffer.from(..,'hex') truncates, so the
    // decoded buffers differ in length and the catch returns false.
    const body = '{"a":1}'
    const malformed = 'z'.repeat(64)
    assert.equal(malformed.length, sign(body).length)
    assert.isFalse(verifyWebhookSignature(body, malformed, SECRET))
  })
})

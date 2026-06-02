import { createHmac } from 'node:crypto'

/**
 * Generate a Stripe-compatible `stripe-signature` header for a payload.
 * Useful in tests and the `tenant:billing:test-webhook` ace command.
 *
 * Mirrors the format Stripe ships:
 *   `t=<timestamp>,v1=<HMAC-SHA256(timestamp + '.' + body, secret)>`
 *
 * The Stripe SDK's `webhooks.constructEvent` validates HMAC-SHA256 with
 * a configurable timestamp tolerance (default 300s). Pass `timestamp` to
 * test stale-signature edge cases (e.g. 10-minute-old `t=` should fail
 * verification).
 */
export function signWebhookPayload(
  payload: string | Buffer,
  secret: string,
  timestamp: number = Math.floor(Date.now() / 1000)
): string {
  const body = typeof payload === 'string' ? payload : payload.toString('utf8')
  const signedPayload = `${timestamp}.${body}`
  const v1 = createHmac('sha256', secret).update(signedPayload).digest('hex')
  return `t=${timestamp},v1=${v1}`
}

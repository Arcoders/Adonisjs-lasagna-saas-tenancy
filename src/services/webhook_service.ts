import TenantWebhook from '../models/satellites/tenant_webhook.js'
import TenantWebhookDelivery from '../models/satellites/tenant_webhook_delivery.js'
import { encrypt, decrypt } from '../utils/crypto.js'
import { DateTime } from 'luxon'
import { createHmac, timingSafeEqual } from 'node:crypto'

export const MAX_ATTEMPTS = 5

export const BACKOFF_BASE_SECONDS = [10, 60, 300, 1800, 7200] as const

/**
 * Verify a webhook signature on the receiver side. The package signs
 * outgoing webhooks with `HMAC-SHA256(secret, JSON.stringify(payload))`
 * and sends the hex digest in the `x-webhook-signature` header.
 * Receivers MUST verify with this helper rather than rolling their
 * own — naive `===` comparisons leak timing, and re-serializing the
 * body before hashing produces a different digest.
 *
 * @param rawBody — the EXACT bytes the receiver got, NOT a re-serialized
 *   object. The signature was computed over the wire bytes; any
 *   round-trip through JSON.parse + JSON.stringify changes the digest.
 * @param signatureHeader — the value of `x-webhook-signature` (hex).
 * @param secret — the plain (already-decrypted) shared secret.
 * @returns `true` iff the signature matches in constant time.
 */
export function verifyWebhookSignature(
  rawBody: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string
): boolean {
  if (!signatureHeader || typeof signatureHeader !== 'string') return false
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex')
  // Both digests are hex with the same length when produced by sha256,
  // but a malformed header could be any length — `timingSafeEqual`
  // throws on length mismatch, so guard first.
  if (signatureHeader.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signatureHeader, 'hex'))
  } catch {
    // Buffer.from(<bad-hex>, 'hex') silently truncates; a length
    // mismatch after decoding means the header was malformed.
    return false
  }
}

const RETRY_CONCURRENCY = 10

function backoffWithJitter(attempt: number): number {
  const base = BACKOFF_BASE_SECONDS[attempt - 1] ?? 7200
  const jitter = base * 0.2 * (Math.random() * 2 - 1)
  return Math.round(base + jitter)
}

async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    await Promise.all(items.slice(i, i + concurrency).map(fn))
  }
}

export default class WebhookService {
  async dispatch(tenantId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const hooks = await TenantWebhook.query()
      .where('tenant_id', tenantId)
      .where('enabled', true)
      .whereRaw('? = ANY(events)', [event])

    await Promise.all(hooks.map((hook) => this.deliver(hook, event, payload)))
  }

  private async deliver(
    hook: TenantWebhook,
    event: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    const delivery = await TenantWebhookDelivery.create({
      webhookId: hook.id,
      event,
      payload,
      status: 'pending',
      attempt: 1,
    })

    await this.send(hook, delivery)
  }

  async send(hook: TenantWebhook, delivery: TenantWebhookDelivery): Promise<void> {
    const body = JSON.stringify(delivery.payload)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-webhook-event': delivery.event,
      'x-delivery-id': delivery.id,
    }

    if (hook.secret) {
      const plainSecret = decrypt(hook.secret)
      headers['x-webhook-signature'] = createHmac('sha256', plainSecret).update(body).digest('hex')
    }

    try {
      const res = await fetch(hook.url, {
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(10000),
      })
      delivery.statusCode = res.status
      delivery.responseBody = await res.text().catch(() => null)
      delivery.status = res.ok ? 'success' : 'failed'

      if (!res.ok && delivery.attempt < MAX_ATTEMPTS) {
        delivery.status = 'retrying'
        delivery.nextRetryAt = DateTime.utc().plus({ seconds: backoffWithJitter(delivery.attempt) })
        delivery.attempt += 1
      }
    } catch (err) {
      delivery.statusCode = null
      delivery.responseBody = String(err)
      delivery.status = delivery.attempt < MAX_ATTEMPTS ? 'retrying' : 'failed'

      if (delivery.status === 'retrying') {
        delivery.nextRetryAt = DateTime.utc().plus({ seconds: backoffWithJitter(delivery.attempt) })
        delivery.attempt += 1
      }
    }

    await delivery.save()
  }

  async processRetries(): Promise<void> {
    const due = await TenantWebhookDelivery.query()
      .where('status', 'retrying')
      .where('next_retry_at', '<=', DateTime.utc().toISO())
      .preload('webhook')
      .limit(100)

    await mapConcurrent(due, RETRY_CONCURRENCY, (d) => this.send(d.webhook, d))
  }

  async registerWebhook(
    tenantId: string,
    url: string,
    events: string[],
    secret?: string
  ): Promise<TenantWebhook> {
    const encryptedSecret = secret ? encrypt(secret) : null
    return TenantWebhook.create({ tenantId, url, events, secret: encryptedSecret, enabled: true })
  }

  async listWebhooks(tenantId: string): Promise<TenantWebhook[]> {
    return TenantWebhook.query().where('tenant_id', tenantId).orderBy('created_at', 'desc')
  }

  async deleteWebhook(id: string, tenantId: string): Promise<void> {
    await TenantWebhook.query().where('id', id).where('tenant_id', tenantId).delete()
  }
}

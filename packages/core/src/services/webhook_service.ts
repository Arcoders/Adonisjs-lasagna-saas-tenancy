import TenantWebhook from '../models/satellites/tenant_webhook.js'
import TenantWebhookDelivery from '../models/satellites/tenant_webhook_delivery.js'
import { encrypt, decrypt } from '../utils/crypto.js'
import {
  validateExternalHttpsUrl,
  validateResolvedHostIsPublic,
  isLoopbackUrl,
} from '../utils/url.js'
import { DateTime } from 'luxon'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

const lazyLogger = () =>
  import('@adonisjs/core/services/logger').then((m) => m.default).catch(() => null)

export const MAX_ATTEMPTS = 5

export interface RegisterWebhookResult {
  hook: TenantWebhook
  /**
   * Present only when the service generated the signing secret (the caller
   * omitted it). This is the ONE time the plaintext is disclosed — it is
   * stored encrypted and cannot be read back later. Hand it to the
   * subscriber now.
   */
  generatedSecret?: string
}

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
    // allSettled so one row's failure (e.g. a save() conflict) can't abort the
    // whole sweep — every `* * * * *` retry tick must make progress on the rest.
    const results = await Promise.allSettled(items.slice(i, i + concurrency).map(fn))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed > 0) {
      const logger = await lazyLogger()
      logger?.warn({ failed, batch: results.length }, 'webhook.retry: some deliveries threw')
    }
  }
}

export default class WebhookService {
  async dispatch(tenantId: string, event: string, payload: Record<string, unknown>): Promise<void> {
    const hooks = await TenantWebhook.query()
      .where('tenant_id', tenantId)
      .where('enabled', true)
      .whereRaw('? = ANY(events)', [event])

    // allSettled, not all: each delivery persists its own outcome in send(), so
    // one hook's unexpected failure (e.g. the delivery-row INSERT erroring) must
    // not reject the whole dispatch and hide the siblings.
    const results = await Promise.allSettled(
      hooks.map((hook) => this.deliver(hook, event, payload))
    )
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed > 0) {
      const logger = await lazyLogger()
      logger?.warn(
        { tenantId, event, failed, total: hooks.length },
        'webhook.dispatch: some deliveries failed to enqueue (see per-delivery rows)'
      )
    }
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
    // SSRF guard at the fetch boundary. The admin controller validates URLs on
    // create/update, but auto-dispatch (`dispatch`) and the retry sweep
    // (`processRetries`) reach this method with a stored URL that may have been
    // written via the service API, a prior package version, or a host that
    // rebound its DNS to an internal address. Refuse here rather than trust the
    // upstream check. This also resolves the hostname and rejects any address
    // in a private/metadata range. A structurally-unsafe URL is permanent, so
    // fail without scheduling a retry.
    //
    // Escape hatch: WEBHOOKS_ALLOW_LOOPBACK_TARGETS=true exempts *loopback*
    // targets (localhost / 127.0.0.0/8 / ::1) only. Off by default — production
    // stays locked down. Even when enabled, private (RFC 1918) and cloud-metadata
    // ranges stay blocked, so the flag can't be turned into a metadata SSRF. Opt
    // in for tests/dev that deliver to an in-process listener on 127.0.0.1.
    const allowLoopback =
      process.env.WEBHOOKS_ALLOW_LOOPBACK_TARGETS === 'true' && isLoopbackUrl(hook.url)
    const urlError = allowLoopback ? null : await validateResolvedHostIsPublic(hook.url)
    if (urlError) {
      delivery.statusCode = null
      delivery.responseBody = `blocked_unsafe_url:${urlError}`
      delivery.status = 'failed'
      delivery.nextRetryAt = null
      await delivery.save()
      return
    }

    const body = JSON.stringify(delivery.payload)
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'x-webhook-event': delivery.event,
      'x-delivery-id': delivery.id,
    }

    if (hook.secret) {
      // A stored secret that can't be decrypted (APP_KEY rotated, ciphertext
      // corrupted) is a PERMANENT failure. Decrypting OUTSIDE this guard would
      // throw straight out of send(), leaving the delivery row stuck `pending`
      // (the retry sweep only selects `retrying`) and — through the allSettled
      // fan-out — surfacing as a rejection. Mark it failed with no retry and
      // stop here instead.
      try {
        const plainSecret = decrypt(hook.secret)
        headers['x-webhook-signature'] = createHmac('sha256', plainSecret)
          .update(body)
          .digest('hex')
      } catch (err) {
        delivery.statusCode = null
        delivery.responseBody = `secret_decrypt_failed:${(err as Error)?.message ?? String(err)}`
        delivery.status = 'failed'
        delivery.nextRetryAt = null
        await delivery.save()
        return
      }
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
    // At-least-once: this sweep does not claim rows, so two instances running
    // the `* * * * *` cron can both pick the same `retrying` row and double-send
    // (possibly one over MAX_ATTEMPTS). Receivers MUST dedupe on `x-delivery-id`.
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
  ): Promise<RegisterWebhookResult> {
    // Validate at the service boundary too, so callers that bypass the admin
    // controller can't persist an SSRF-capable URL.
    const urlError = validateExternalHttpsUrl(url)
    if (urlError) {
      throw new Error(`WebhookService: refusing to register an unsafe webhook url (${urlError}).`)
    }
    // Every webhook gets a signing secret: when the caller doesn't provide
    // one, generate it. Deliveries from a secretless hook would be unsigned
    // and the receiver couldn't authenticate them — a silent downgrade no
    // caller actually wants. An empty string counts as "not provided" —
    // otherwise it would be encrypted and used as an HMAC key of length 0.
    const provided = secret || undefined
    const plainSecret = provided ?? randomBytes(32).toString('hex')
    const hook = await TenantWebhook.create({
      tenantId,
      url,
      events,
      secret: encrypt(plainSecret),
      enabled: true,
    })
    return provided ? { hook } : { hook, generatedSecret: plainSecret }
  }

  async listWebhooks(tenantId: string): Promise<TenantWebhook[]> {
    return TenantWebhook.query().where('tenant_id', tenantId).orderBy('created_at', 'desc')
  }

  async deleteWebhook(id: string, tenantId: string): Promise<void> {
    await TenantWebhook.query().where('id', id).where('tenant_id', tenantId).delete()
  }
}

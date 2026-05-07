---
title: Webhooks
description: HMAC-signed outbound events with delivery state machine, retries, and per-subscription secrets encrypted at rest.
---

# Webhooks

Outbound webhooks for tenant events, with HMAC-SHA256 signatures,
explicit delivery state machine, and exponential-backoff retries.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=webhooks
```

## Subscribing

```ts
import { WebhookService } from '@adonisjs-lasagna/saas-tenancy/services'

const webhooks = await app.container.make(WebhookService)

await webhooks.subscribe({
  tenantId: tenant.id,
  events: ['tenant.activated', 'subscription.upgraded'],
  url: 'https://acme.com/hooks/lasagna',
  // Generated when omitted; encrypted at rest with APP_KEY (AES-256-GCM).
  secret: undefined,
})
```

## Sending

```ts
await webhooks.dispatch({
  tenantId: tenant.id,
  event: 'subscription.upgraded',
  payload: { fromPlan: 'starter', toPlan: 'pro' },
})
```

The dispatch enqueues a job that POSTs the payload with:

- `content-type: application/json`
- `x-webhook-signature: <hex>` — HMAC-SHA256 over the raw body using
  the per-subscription secret. Plain hex digest, no `sha256=` prefix.
- `x-webhook-event: <event>`
- `x-delivery-id: <uuid>`

## Verifying on the receiver

The package exports a constant-time helper. Use this rather than
rolling your own — naive `===` comparisons leak timing, and
re-serializing the body before hashing produces a different digest:

```ts
import { verifyWebhookSignature } from '@adonisjs-lasagna/saas-tenancy/services'

router.post('/webhooks/inbound', async ({ request, response }) => {
  const rawBody = request.raw() ?? ''
  const signature = request.header('x-webhook-signature')
  if (!verifyWebhookSignature(rawBody, signature, RECEIVER_SECRET)) {
    return response.unauthorized({ error: 'bad signature' })
  }
  // ... handle the event
})
```

Pass the EXACT bytes your framework received — not a re-serialized
object. Re-stringifying through `JSON.parse` + `JSON.stringify`
changes the digest.

To defeat replay, log `x-delivery-id` on the receiver and reject
duplicates within a small TTL window.

## Delivery state machine

<WebhookStateMachine />

Retries follow a 5-attempt schedule with `±20%` jitter:

| Attempt | Base delay |
|---|---|
| 1 → 2 | 10 s |
| 2 → 3 | 1 m |
| 3 → 4 | 5 m |
| 4 → 5 | 30 m |
| 5 → 6 | 2 h |

After the 5th attempt, the delivery transitions to `failed` and is
no longer retried by `processRetries()`. Failed deliveries are
surfaced via the admin REST API for inspection or manual replay.

## Cron

```bash
* * * * * node ace tenant:webhooks:retry
```

Picks up `retry_scheduled` deliveries whose `next_retry_at` has
elapsed. Idempotent.

## Admin REST

```http
GET    /admin/multitenancy/tenants/{id}/webhooks
POST   /admin/multitenancy/tenants/{id}/webhooks
DELETE /admin/multitenancy/tenants/{id}/webhooks/{webhookId}
GET    /admin/multitenancy/tenants/{id}/webhooks/{webhookId}/deliveries
```

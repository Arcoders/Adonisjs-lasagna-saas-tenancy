---
"@adonisjs-lasagna/saas-tenancy": minor
---

Webhook signing secrets now fail closed: delivery requires the stored
`tenant_webhooks.secret` to be `enc_v1` ciphertext.

Previously, `WebhookService.send()` decrypted the stored secret leniently — a
value without the `enc_v1:` prefix was passed through and used as the HMAC key
as-is. That meant a plaintext, corrupted, or wrong-key secret was silently
signed with raw column bytes instead of failing. Delivery now uses
`decryptStrict`, so any non-`enc_v1` secret marks the delivery failed (no
retry) rather than signing with the wrong key. `registerWebhook()` already
encrypts, so the supported path is unaffected; the demo controller now also
encrypts at the write boundary so the reference example models best practice.

**⚠ Action required if you stored plaintext webhook secrets** (for example by
writing `tenant_webhooks.secret` directly, as the demo controller used to do).
Run the one-time, idempotent upgrade command before deliveries resume:

```bash
node ace tenant:webhooks:encrypt-secrets --dry-run   # preview
node ace tenant:webhooks:encrypt-secrets             # encrypt at rest
```

If you only ever created webhooks through `registerWebhook()`, no action is
needed — those secrets are already encrypted.

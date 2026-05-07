---
title: Impersonation
description: Admin enters a tenant as a target user. Time-boxed, audited, HMAC-signed, single-use.
---

# Impersonation

Lets an operator enter a tenant as a specific user; for support
work, debugging, or onboarding. The flow is time-boxed (default 1
hour), single-use, HMAC-signed, and audited end-to-end.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=impersonation
```

## Requirements

`config/multitenancy.ts` must include:

```ts
impersonation: {
  secret: env.get('IMPERSONATION_SECRET'),  // ≥ 32 chars; validated at boot
  defaultDuration: 900,                     // seconds, default 900 (15 min)
  maxDuration: 24 * 60 * 60,                // seconds, default 24h. consume() clamps requests to [60, maxDuration]
}
```

The provider validates the secret length at boot; a misconfigured
deploy fails fast on startup, not on the first impersonation
request.

## Issuing a token

```bash
node ace tenant:impersonate <tenantId> <userId> \
  --admin=admin-42 \
  --duration=900 \
  --reason="support ticket #1234"
```

```ts
import { ImpersonationService } from '@adonisjs-lasagna/saas-tenancy/services'

const impersonation = await app.container.make(ImpersonationService)

const { token, redirectUrl } = await impersonation.issue({
  tenantId: tenant.id,
  targetUserId: 'user-abc',
  adminId: 'admin-42',
  durationSeconds: 900,
  reason: 'support ticket #1234',
  path: '/dashboard',
})
```

## Verifying

```ts
import { ImpersonationMiddleware } from '@adonisjs-lasagna/saas-tenancy/middleware'

router.use([ImpersonationMiddleware])
```

The middleware:

1. Reads the token from the `imp` query param or
   `x-impersonation-token` header.
2. HMAC-verifies it with `crypto.timingSafeEqual`.
3. Looks up the Redis-backed grant (single-use; consumes on read).
4. Sets `request.impersonation = { adminId, targetUserId, reason }`.

## Audit trail

Every issue and use is recorded via the audit satellite if enabled:

| Event | Recorded |
|---|---|
| `impersonation.granted` | `adminId`, `tenantId`, `targetUserId`, `reason`, `expiresAt` |
| `impersonation.consumed` | `adminId`, `tenantId`, `targetUserId`, IP, user-agent |
| `impersonation.expired` | `adminId`, `tenantId`, `targetUserId` |

## Security guarantees

- Tokens are HMAC-SHA256 over a fixed-size payload.
- Verification uses `timingSafeEqual`; constant-time, no oracle.
- The shared secret is validated as ≥ 32 chars at provider boot.
- Tokens are single-use; Redis `GETDEL` consumes the grant.
- Tokens cannot be re-issued from a captured one; they sign a
  random nonce, not a deterministic identifier.

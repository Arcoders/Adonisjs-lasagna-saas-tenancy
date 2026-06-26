---
title: Impersonation
description: Admin enters a tenant as a target user. Time-boxed, tenant-bound, HMAC-signed, revocable, audited.
---

# Impersonation

Lets an operator enter a tenant as a specific user; for support
work, debugging, or onboarding. The flow is time-boxed (default 1
hour), bound to the tenant it was issued for, HMAC-signed, revocable,
and audited.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=impersonation
```

## Requirements

`config/multitenancy.ts` must include:

```ts
impersonation: {
  secret: env.get('IMPERSONATION_SECRET'),  // ≥ 32 chars; validated at boot
  defaultDuration: 900,                     // seconds; the default when omitted (15 min)
  maxDuration: 24 * 60 * 60,                // seconds, default 24h. start() clamps requests to [60, maxDuration]
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

const { token, sessionId, expiresAt } = await impersonation.start({
  tenantId: tenant.id,
  targetUserId: 'user-abc',
  adminId: 'admin-42',
  durationSeconds: 900,
  reason: 'support ticket #1234',
})
```

The ace command additionally prints a ready-to-paste redirect URL.
Sessions can be ended early with `stop(token)` or, from an admin
surface, `revokeById(sessionId)`.

## Verifying

```ts
import { ImpersonationMiddleware } from '@adonisjs-lasagna/saas-tenancy/middleware'

router.use([ImpersonationMiddleware])
```

The middleware:

1. Reads the token from the `x-impersonation-token` header or the
   `__impersonation` cookie (both names configurable). Query-string
   tokens are deliberately not supported; they leak into access
   logs and referrers.
2. HMAC-verifies it with `crypto.timingSafeEqual` and loads the
   Redis-backed session (TTL = the session duration).
3. Binds the token to the request's tenant: a token issued for
   tenant A presented on tenant B's request is rejected with a 401.
4. Sets `ctx.impersonation` to the verified session context
   (`adminId`, `targetUserId`, `tenantId`, `reason`, timestamps).

## Audit trail

Every step is recorded through the audit satellite when enabled,
under `admin:impersonate:*` actions:

| Action | Recorded |
|---|---|
| `admin:impersonate:start` | `sessionId`, `targetUserId`, `durationSeconds`, `reason`, actor + IP |
| `admin:impersonate:first-use` | the first request the session is used on (one entry per session, not per request) |
| `admin:impersonate:stop` | explicit revocation via `stop()` / `revokeById()` |

Expiry needs no audit row of its own; the session simply disappears
when its Redis TTL lapses; the `start` row carries the planned
duration.

Impersonation is one writer among several. When you mount the
[admin satellite](/guides/satellites/admin), every other admin mutation
(tenant lifecycle, webhooks, feature flags, branding, SSO, quotas, custom
actions) is also recorded under an `admin:<resource>:<verb>` action with the
acting admin attributed. See the
[Admin guide's Audit & accountability section](/guides/satellites/admin#audit-accountability).

## Security guarantees

- Tokens are HMAC-SHA256 over a random 16-byte session id, so a
  captured token cannot be used to forge or re-derive another one.
- Verification uses `timingSafeEqual`; constant-time, no oracle.
- The shared secret is validated as ≥ 32 chars at provider boot and
  again at use.
- Tokens are tenant-bound: presenting one on another tenant's
  request throws `ImpersonationInvalidException` (401).
- Sessions are time-boxed by a Redis TTL and revocable at any moment
  (`stop()` / `revokeById()`). A token stays valid for its whole
  session window, so treat it like a short-lived credential and keep
  durations tight for support work.

## Read next

- [Authentication](/guides/authentication); operators acting as tenant users.
- [Security](/guides/security); the token and audit guarantees.
- [Production checklist](/reference/production-checklist); the hardening runbook before you ship.
- [Satellites](/guides/satellites/); the rest of the opt-in features.

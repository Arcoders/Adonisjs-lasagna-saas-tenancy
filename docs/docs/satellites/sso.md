---
title: SSO
description: Per-tenant OIDC config with full id_token verification; JWKS, iss/aud/exp, nonce binding.
---

# SSO

Per-tenant OpenID Connect configuration. The package handles
discovery, JWKS-backed `id_token` verification, nonce/state binding,
and SSRF guards on the issuer URL.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=sso
npm install jose
```

`jose` is an optional peer dependency; only required when SSO is
enabled.

## What gets verified

Every callback hits `SsoService.handleCallback()`, which:

1. Generates state with `randomBytes(16)`, single-use, 600 s TTL.
2. Generates nonce with `randomBytes(16)`, bound to state, included
   on the auth URL.
3. Verifies the token endpoint returns an `id_token`.
4. Verifies the `id_token` against the IdP's JWKS (cached 1 h via
   discovery).
5. Checks `iss`, `aud`, `exp` via `jose.jwtVerify` (60 s clock
   tolerance).
6. Confirms the `nonce` in the `id_token` payload matches the value
   bound to state.

Any mismatch throws and aborts the callback before claims surface.

## Discovery hardening

The `discover()` method:

- Verifies the discovery doc's `issuer` matches the requested issuer
  (OIDC Discovery 1.0 §4.3).
- Applies `validateExternalHttpsUrl` to the discovered
  `token_endpoint` and `jwks_uri`; defends against SSRF (loopback,
  RFC 1918, link-local, cloud metadata, IPv6 brackets).

## Storing config

```ts
import { SsoService } from '@adonisjs-lasagna/saas-tenancy/services'

const sso = await app.container.make(SsoService)

await sso.upsert(tenant.id, {
  issuerUrl: 'https://login.acme.com/.well-known/openid-configuration',
  clientId: env.get('ACME_OIDC_CLIENT_ID'),
  clientSecret: env.get('ACME_OIDC_CLIENT_SECRET'),
  redirectUri: 'https://app.example.com/auth/callback',
  scopes: ['openid', 'profile', 'email'],
})
```

The admin REST endpoint that wires this also runs `issuerUrl`
through `validateExternalHttpsUrl()` so a mis-configured tenant
cannot make the server reach a private network.

## Login flow

```ts
import { SsoService } from '@adonisjs-lasagna/saas-tenancy/services'

router
  .get('/auth/login', async ({ request, response }) => {
    const sso = await app.container.make(SsoService)
    const tenant = await request.tenant()
    const { authUrl, state } = await sso.startLogin(tenant.id)
    response.cookie('oidc_state', state, { httpOnly: true, secure: true })
    return response.redirect(authUrl)
  })
  .as('auth.login')

router
  .get('/auth/callback', async ({ request }) => {
    const sso = await app.container.make(SsoService)
    const tenant = await request.tenant()
    const claims = await sso.handleCallback(tenant.id, {
      code: request.input('code'),
      state: request.input('state'),
      cookieState: request.cookie('oidc_state'),
    })
    // claims.sub, claims.email, claims.name, …
  })
  .as('auth.callback')
```

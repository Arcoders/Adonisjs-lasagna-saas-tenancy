---
title: Branding
description: Per-tenant logo, colors, custom domain, and encrypted SMTP credentials.
---

# Branding

Stores tenant-customisable presentation values: logo URL, primary
colors, custom domain, and (encrypted) SMTP credentials for the mail
bootstrapper.

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=branding
```

## Schema

`tenant_brandings` has one row per tenant:

| Column | Notes |
|---|---|
| `tenant_id` | FK + unique |
| `logo_url` | Public URL or drive path |
| `primary_color` | Hex, e.g. `#C26A4B` |
| `accent_color` | Hex |
| `custom_domain` | Hostname, used by `CustomDomainMiddleware` |
| `smtp_*` | Host/port/user/password/from; `smtp_password` AES-256-GCM encrypted |

## API

```ts
import { BrandingService } from '@adonisjs-lasagna/saas-tenancy/services'

const branding = await app.container.make(BrandingService)

await branding.update(tenant.id, {
  logoUrl: 'https://cdn.example.com/acme.svg',
  primaryColor: '#C26A4B',
  customDomain: 'acme.com',
})

const current = await branding.get(tenant.id)
// SMTP password is decrypted on read; encrypt-on-write happens inside the service.
```

## Custom domains

Setting `custom_domain` only stores the value. Wiring the request
to resolve to this tenant requires the `CustomDomainMiddleware`:

```ts
// start/kernel.ts
server.use([
  () => import('@adonisjs-lasagna/saas-tenancy/middleware')
    .then(m => ({ default: m.CustomDomainMiddleware })),
])
```

The middleware queries the repository (`findByDomain(host)`) and
rewrites the request before tenant resolution runs. Wildcard TLS,
LetsEncrypt, and the Cloudflare-style "for-the-rest-we-issue-a-cert"
flow are your job; see the
[deployment guide](/docs/deployment#wildcard-subdomains) for
patterns.

## At-rest encryption

SMTP passwords (and any column you add via the encryption helpers
in `utils/crypto.ts`) are encrypted with `AES-256-GCM` using
`APP_KEY`. Rotation requires re-encryption; the package does not
ship a migration helper for that yet.

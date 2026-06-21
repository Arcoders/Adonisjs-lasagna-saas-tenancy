---
title: Branding
description: Per-tenant email sender identity and presentation values (logo, colors).
---

# Branding

Stores tenant-customisable presentation values used when composing email and
rendering tenant-facing UI: a sender name and address, a logo URL, a primary
color, a support URL, and a free-form email footer. It holds **no secrets**:
mail transport (SMTP host/credentials) is a host-app concern; see the
[mail bootstrapper](/docs/bootstrappers/mail).

## Configuration

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=branding
```

## Schema

`tenant_brandings` has one row per tenant:

| Column | Notes |
|---|---|
| `tenant_id` | FK + unique |
| `from_name` | Sender display name for outbound mail |
| `from_email` | Sender address for outbound mail |
| `logo_url` | Public URL or drive path |
| `primary_color` | Hex, e.g. `#C26A4B` |
| `support_url` | Public support link |
| `email_footer` | Free-form JSON merged into the email context |
| `created_at` / `updated_at` | timestamps |

## API

```ts
import { BrandingService } from '@adonisjs-lasagna/saas-tenancy/services'

const branding = await app.container.make(BrandingService)

await branding.upsert(tenant.id, {
  fromName: 'Acme',
  fromEmail: 'hello@acme.com',
  logoUrl: 'https://cdn.example.com/acme.svg',
  primaryColor: '#C26A4B',
  supportUrl: 'https://acme.com/support',
})

const current = await branding.getForTenant(tenant.id) // cached 300 s; upsert busts it

// Same as getForTenant, but resolves the tenant id from the ambient scope
// (an HTTP request, or a tenancy.run(tenant, fn) block). Throws outside a scope.
const mine = await branding.getCurrent()

// Build a defaults-filled context for an email template.
const ctx = branding.renderEmailContext(current)
```

## Custom domains

Custom domains are **not** a branding concern; the hostname lives on the tenant
model (`custom_domain`), and `CustomDomainMiddleware` queries the repository
(`findByDomain(host)`) to resolve it. See
[tenant identification](/docs/tenant-identification).

## Secrets

Branding stores no credentials, so there is nothing here to encrypt or rotate.
If your app does encrypt tenant secrets, the `utils/crypto.ts` helpers
(`AES-256-GCM` keyed on `APP_KEY`) and the `tenant:secrets:reencrypt` command
(which rotates the package's encrypted columns, webhook signing secrets and SSO
client secrets) are the supported path; add any new encrypted column to that
command's table list.


## Read next

- [Admin REST API](/docs/satellites/admin-rest-api); managing branding over HTTP.
- [Production checklist](/docs/production-checklist); the hardening runbook before you ship.
- [Satellites](/docs/satellites/); the rest of the opt-in features.

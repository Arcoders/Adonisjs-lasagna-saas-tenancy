---
title: Mail bootstrapper
description: Tenant-stamped outbound mail via tenantMailer(). Per-tenant transport selection stays a host-app decision.
---

# Mail bootstrapper

Auto-detected when `@adonisjs/mail` is installed. It validates the
tenant id at scope entry (the id lands in outbound message headers)
and gives you `tenantMailer()`, a mailer handle that stamps
`X-Tenant-Id` on every message it sends, so bounces, provider logs,
and webhook events can always be traced back to the tenant.

## What it does

```ts
import { tenantMailer } from '@adonisjs-lasagna/saas-tenancy/services'

const mailer = await tenantMailer()
await mailer.send((message) => {
  message.to(user.email).subject('Welcome!')
  // X-Tenant-Id: <active tenant id> is injected automatically
})
```

It throws outside a `tenancy.run()` scope. `sendLater` is wrapped the
same way.

## Per-tenant transports and From addresses

Selecting a different SMTP transport or `from` address per tenant is
deliberately a host-app decision; the package can't know where your
credentials live or what your deliverability setup looks like. Pass
the transport name yourself, resolved however you like:

```ts
const tenant = await tenancy.current()
const transport = tenant?.metadata?.mailTransport // your own convention
const mailer = await tenantMailer(transport)
await mailer.send((message) => {
  message.from(brandingFor(tenant).fromAddress).to(user.email)
})
```

## At-rest encryption

When tenants store SMTP passwords, they belong in the
`tenant_brandings` table with the encrypted column treatment from
`utils/crypto.ts`. The `BrandingService` handles encrypt-on-write /
decrypt-on-read. Avoid plain text columns.

## Common pitfall

Setting `from` per tenant changes the **DKIM signing domain** that
your provider uses. If your tenants bring their own domains, ensure
each domain has the right DKIM record published; otherwise your
emails land in spam.

## Read next

- [Bootstrappers](/guides/bootstrappers/); the rest of the per-tenant services.
- [Branding](/guides/satellites/branding); where per-tenant SMTP settings live encrypted.

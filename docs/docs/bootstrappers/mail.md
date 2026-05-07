---
title: Mail bootstrapper
description: Per-tenant SMTP credentials and From address. Useful when each tenant signs outbound mail with their own domain.
---

# Mail bootstrapper

Auto-detected when `@adonisjs/mail` is installed. Lets each tenant
ship outbound mail under their own brand without forking your
mailers.

## What it does

For the duration of the tenant context, `mail.send(...)` resolves
the SMTP credentials and the `from` address from the tenant's
branding record (or any row source you configure). Outside the
tenant context, mail uses your default config.

## Configuration

```ts
// config/multitenancy.ts
export default defineConfig({
  mail: {
    enabled: true,
    resolver: async (tenant) => {
      // Anything you want — this is just a function.
      return {
        from: tenant.brandingFrom ?? `noreply@${tenant.customDomain}`,
        // Per-tenant SMTP override, or null to use the default mailer.
        smtp: tenant.smtpHost
          ? {
              host: tenant.smtpHost,
              port: tenant.smtpPort,
              secure: tenant.smtpSecure,
              auth: {
                user: tenant.smtpUser,
                pass: tenant.smtpPasswordPlaintext, // see Branding service for at-rest encryption
              },
            }
          : null,
      }
    },
  },
})
```

## At-rest encryption

When tenants store SMTP passwords, they belong in the
`tenant_brandings` table with the encrypted column treatment from
`utils/crypto.ts`. The `BrandingService` handles encrypt-on-write /
decrypt-on-read. Avoid plain text columns.

## Reply-to and tracking

Same idea; read whatever you need from the tenant row and return it
from the resolver. The bootstrapper trusts your resolver completely;
it does no tenant-specific transformation beyond what you tell it.

## Common pitfall

Setting `from` per tenant changes the **DKIM signing domain** that
your provider uses. If your tenants bring their own domains, ensure
each domain has the right DKIM record published; otherwise your
emails land in spam.

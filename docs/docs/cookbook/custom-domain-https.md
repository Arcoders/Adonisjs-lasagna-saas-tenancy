---
title: Custom-domain HTTPS
description: Issue a per-tenant TLS certificate without touching your origin. Two paths; Cloudflare for Saas (zero-config) and cert-manager + DNS-01 (self-managed).
---

# Custom-domain HTTPS

Two paths, depending on whether you control DNS for the tenant.

## Path 1; Cloudflare for SaaS

The least-friction option. Tenants point a `CNAME` from their root
domain to `acme.app.example.com`; Cloudflare issues and rotates the
cert on their edge. Your origin only ever sees the apex hostname.

### Steps

1. Enable **Cloudflare for SaaS** on your zone.
2. Set the fallback origin to `app.example.com`.
3. POST to Cloudflare's API when a tenant adds a custom domain:

   ```ts
   await fetch('https://api.cloudflare.com/client/v4/zones/<zone>/custom_hostnames', {
     method: 'POST',
     headers: {
       authorization: `Bearer ${env.get('CF_API_TOKEN')}`,
       'content-type': 'application/json',
     },
     body: JSON.stringify({
       hostname: tenant.customDomain,
       ssl: { method: 'http', type: 'dv' },
     }),
   })
   ```

4. The tenant adds the `CNAME` and Cloudflare issues the cert.
   Validate via the Cloudflare webhook or by polling the API.
5. Your `CustomDomainMiddleware` already maps the hostname to the
   tenant via `branding.custom_domain`. Done.

### When to use it

- You want zero touch on the origin (no cert renewal, no Ingress
  changes).
- Tenants are end customers without DevOps teams.
- The 4 ¢ / month per hostname is acceptable.

## Path 2; cert-manager + DNS-01

You manage everything in-house. Wildcard cert for the apex
(`*.app.example.com`), per-tenant certs for custom domains.

### Wildcard apex (DNS-01)

```yaml
# Issuer (cert-manager) — one-time setup
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-dns01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ops@example.com
    privateKeySecretRef:
      name: letsencrypt-dns01
    solvers:
      - dns01:
          route53:
            region: us-east-1
            # IRSA / IAM role for the cert-manager pod
```

```yaml
# Wildcard cert
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: app-example-com-tls
  namespace: lasagna
spec:
  secretName: app-example-com-tls
  issuerRef:
    name: letsencrypt-dns01
    kind: ClusterIssuer
  dnsNames:
    - app.example.com
    - "*.app.example.com"
```

### Per-tenant custom domain

When a tenant adds `acme.com`:

1. Validate they own it (e.g., `_lasagna-verify` TXT record).
2. Create a `Certificate` resource per tenant; single-name, HTTP-01
   solver because Let's Encrypt allows HTTP-01 for non-wildcard
   issuance.
3. Reference the resulting `Secret` in the Ingress `tls` entries.

A small operator (or a controller in your app) is the cleanest way to
manage the lifecycle. The package does not ship one; this recipe
gives you the moving parts.

## Common pitfalls

- **Wildcard cert with HTTP-01**: doesn't work. Wildcards require
  DNS-01.
- **`Host` header mismatch**: cert is `acme.com`, but the request
  arrives as `www.acme.com`. Add both names to the `Certificate`
  spec, or strip the `www.` in `CustomDomainMiddleware`.
- **HSTS preload**: tenants who enable HSTS preload through your
  apex domain commit to TLS for the apex *and every subdomain* for
  ~2 years. Confirm with each tenant before adding.
- **Header-domain disagreement**: by default the verified `Host`-resolved
  custom domain is authoritative; a conflicting `x-tenant-id` header is
  rejected with `E_TENANT_HEADER_DOMAIN_MISMATCH` (400), closing the
  tenant-hop vector. Opt out with `middleware.customDomain({ strict: false })`
  only if you intentionally route by header on managed domains. See
  [Routing's strict mode](/docs/routing#strict-mode-the-default).

## Read next

- [Branding satellite](/docs/satellites/branding); where
  `custom_domain` is stored.
- [Routing, custom domain mapping](/docs/routing#custom-domain-mapping)

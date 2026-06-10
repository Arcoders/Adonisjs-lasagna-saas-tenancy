---
title: Satellites
description: Nine opt-in features attached to tenants; audit logs, feature flags, webhooks, branding, SSO, metrics, quotas, impersonation, Stripe billing.
---

# Satellites

<Callout type="tip" title="Opt-in by design">
None of these are required to run Lasagna. Each ships its own
backoffice migration, its own service, and its own admin endpoint.
Enable only what you need; the rest stays as zero-cost dead code in
the bundle (tree-shaken at build time).
</Callout>

## Enabling a satellite

```bash
# Selective at install
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks

# Add a new one later — re-run with the satellite list you want
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks,sso
```

The configure command is idempotent; re-running it does not
duplicate migrations or tenant model scaffolding. For the full
step-by-step of adding a satellite to a running app (packages, config
blocks, recovery), see
[Adding features later](/docs/cookbook/adding-features-incrementally).

## The nine satellites

| Satellite | What it gives you | Storage |
|---|---|---|
| [Audit](/docs/satellites/audit) | Structured audit trail with actor + payload, queryable by date range. | `tenant_audit_logs` |
| [Feature flags](/docs/satellites/feature-flags) | Per-tenant boolean flags (kill switches, beta cohorts), cached. | `tenant_feature_flags` |
| [Webhooks](/docs/satellites/webhooks) | HMAC-signed outbound events with delivery state machine and retries. | `tenant_webhooks`, `tenant_webhook_deliveries` |
| [Branding](/docs/satellites/branding) | Per-tenant logo, colors, custom domain, encrypted SMTP. | `tenant_brandings` |
| [SSO](/docs/satellites/sso) | Per-tenant OIDC config with JWKS-backed verification. | `tenant_sso_configs` |
| [Metrics](/docs/satellites/metrics) | Time-series counters per tenant with cursor-based aggregation. | `tenant_metrics` |
| [Quotas](/docs/satellites/quotas) | Plan-bound limits; rolling and snapshot, served as middleware. | Redis counters + `tenant_plans` |
| [Billing](/docs/satellites/billing) | Stripe integration — idempotent webhook, dunning, metered, checkout/portal, lifecycle hook. | `stripe_customers`, `stripe_subscriptions`, `stripe_processed_events`, `stripe_meter_events` |
| [Impersonation](/docs/satellites/impersonation) | Admin enters a tenant as a target user, time-boxed and audited. | Redis (no DB row) |

## Cross-satellite invariants

- Every satellite that writes to a database table goes through the
  `backoffice` schema; never the per-tenant schema. This makes
  cross-tenant reporting and aggregate queries straightforward.
- The audit satellite is the single point of truth for "who did
  what": impersonation writes its rows automatically, and every other
  satellite's mutations can be recorded through the same
  `AuditLogService.log()` API from your hooks and listeners (see
  [Audit logs](/docs/satellites/audit)).
- Satellites never call each other directly; they go through their
  respective service contracts. Replace one and the rest keep
  working.

## Read next

Pick a satellite from the table above, or look at the
[admin REST API](/docs/admin-rest-api) for the HTTP surface they
share.

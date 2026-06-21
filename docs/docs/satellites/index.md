---
title: Satellites
description: Ten opt-in features attached to tenants; audit logs, feature flags, webhooks, branding, SSO, real-time WebSockets, metrics, quotas, impersonation, Stripe billing.
---

# Satellites

<Callout type="tip" title="Opt-in by design">
None of these are required to run Lasagna. Most ship their own
backoffice migration, service, and admin endpoint (a few, like
WebSockets, are stateless and add none). Enable only what you need;
the rest stays as zero-cost dead code in the bundle (tree-shaken at
build time).
</Callout>

## Enabling a satellite

```bash
# Selective at install (core leaf satellites)
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks

# Add a new one later — re-run with the satellite list you want
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks,metrics

# List what's installable (core bundles + any packaged satellites you have installed)
node ace configure @adonisjs-lasagna/saas-tenancy --list-satellites
```

Packaged satellites (billing, SSO, and any community package) carry
their own migrations. Install them through core by package name, or
run their own configure hook:

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=@adonisjs-lasagna/billing
# equivalently
node ace configure @adonisjs-lasagna/billing
```

The configure command is idempotent; re-running it does not
duplicate migrations or tenant model scaffolding. For the full
step-by-step of adding a satellite to a running app (packages, config
blocks, recovery), see
[Adding features later](/docs/cookbook/adding-features-incrementally).
To build your own, see [Creating a satellite](/docs/cookbook/creating-a-satellite).

## The ten satellites

| Satellite | What it gives you | Storage |
|---|---|---|
| [Audit](/docs/satellites/audit) | Structured audit trail with actor + payload, queryable by date range. | `tenant_audit_logs` |
| [Feature flags](/docs/satellites/feature-flags) | Per-tenant boolean flags (kill switches, beta cohorts), cached. | `tenant_feature_flags` |
| [Webhooks](/docs/satellites/webhooks) | HMAC-signed outbound events with delivery state machine and retries. | `tenant_webhooks`, `tenant_webhook_deliveries` |
| [Branding](/docs/satellites/branding) | Per-tenant logo, colors, custom domain, encrypted SMTP. | `tenant_brandings` |
| [SSO](/docs/satellites/sso) | Per-tenant OIDC config with JWKS-backed verification. | `tenant_sso_configs` |
| [WebSockets](/docs/satellites/websockets) | Bidirectional socket.io, tenant-isolated per connection; per-tenant rooms + per-event tenant context. | None (stateless) |
| [Metrics](/docs/satellites/metrics) | Time-series counters per tenant with cursor-based aggregation. | `tenant_metrics` |
| [Quotas](/docs/satellites/quotas) | Plan-bound limits; rolling and snapshot, served as middleware. | Redis counters + `tenant_plans` |
| [Billing](/docs/satellites/billing) | Stripe integration — idempotent webhook, dunning, metered, checkout/portal, lifecycle hook. | `stripe_customers`, `stripe_subscriptions`, `stripe_processed_events`, `stripe_meter_events` |
| [Impersonation](/docs/satellites/impersonation) | Admin enters a tenant as a target user, time-boxed and audited. | Redis (no DB row) |

<Callout type="note" title="Also documented in this section">
[Backup](/docs/satellites/backup) and [Admin](/docs/satellites/admin) appear in
this section's sidebar but aren't tenant-attached feature satellites like the ten
above. Backup is an operational concern (`pg_dump` with retention tiers, shipped as
`@adonisjs-lasagna/backup`); Admin is the shared REST surface the satellites expose,
not a feature of its own. They live here because that's where you'll look for them.
</Callout>

## Cross-satellite invariants

- Every satellite that writes to a database table goes through the
  `backoffice` schema; never the per-tenant schema. This makes
  cross-tenant reporting and aggregate queries straightforward, and it
  means removing a satellite is a single `migration:rollback` of its
  backoffice tables, with nothing left behind in any per-tenant schema.
- The audit satellite is the single point of truth for "who did
  what": impersonation writes its rows automatically, and every other
  satellite's mutations can be recorded through the same
  `AuditLogService.log()` API from your hooks and listeners (see
  [Audit logs](/docs/satellites/audit)).
- Satellites never call each other directly; they go through their
  respective service contracts. Replace one and the rest keep
  working.

## Build your own

Satellites are a public extension point. The billing, SSO, and WebSockets
satellites ship as their own packages (`@adonisjs-lasagna/billing`,
`@adonisjs-lasagna/sso`, `@adonisjs-lasagna/websockets`): each carries its own
configure hook (plus migrations when it has tables, though WebSockets is stateless
and ships none), and registers itself through core's public registries without core
ever importing it. You can publish your
own the same way and have it discovered by `configure --list-satellites` and
installed with `--with=<package>`. See
[Creating a satellite](/docs/cookbook/creating-a-satellite).

## Read next

Pick a satellite from the table above, or look at the
[admin REST API](/docs/satellites/admin-rest-api) for the HTTP surface they
share.

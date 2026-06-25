---
title: Known limitations
description: A consolidated list of what the package does not do, and where each limitation is covered in depth.
---

# Known limitations

An honest, single-page index of the boundaries to know before adopting. Each item links to
the page that covers it in depth. Nothing here is a bug; these are deliberate scope or
design choices.

## Platform

- **PostgreSQL only, by design.** No MySQL/MariaDB. Schema and database isolation are
  Postgres-native, and `rowscope-pg` relies on PostgreSQL RLS. This is a deliberate product
  decision about focus and quality, not a deferral. See
  [FAQ](/reference/faq#does-it-work-with-mysql-or-mariadb) and [Comparison](/reference/comparison).
- **AdonisJS 7 only, by design.** No adapters for Express, NestJS, or other frameworks. The
  package builds on AdonisJS providers, middleware, ace commands, and container bindings. See
  [FAQ](/reference/faq#does-it-work-with-express-nestjs-or-another-framework).
- **Node.js >= 24.** Required by AdonisJS 7 and Lucid 22.

## Maturity

- **No independent external security review yet.** The isolation core is
  `release-candidate`, not `stable`, precisely because that review and production mileage are
  still open. The satellites are `experimental`. See [Stability](/reference/stability) and the
  [security guide](/guides/security).
- **Single maintainer.** Mitigated by the test and documentation depth, but worth knowing.

## Isolation and data

- **No built-in driver-to-driver migration.** Switching isolation drivers after launch is a
  planned data migration, not a config change. See [FAQ](/reference/faq#can-i-change-isolation-drivers-after-launch).
- **`rowscope-pg`: a non-grouped top-level `orWhere` can escape the auto-scope.** Group your
  `OR` branches, and enable RLS for a database-enforced boundary. See
  [rowscope-pg](/guides/data-isolation/rowscope-pg) and [Models](/guides/models#row-scoped-models-rowscope-pg).
- **Cross-layer Lucid relationships are unsupported.** Tenant, backoffice, and central
  models live on different schemas; relate across layers by id, not by relation. See
  [Models](/guides/models#cross-layer-relationships).
- **Connection-cap default favors availability.** `isolation.enforceConnectionCap` defaults
  to `false`, so a burst of distinct tenants can exceed `maxTenantConnections` rather than
  sever an in-flight request. Turn the hard cap on for PgBouncer-fronted deployments. See
  [Scaling limits](/guides/scaling-limits) and [Troubleshooting](/reference/gotchas).

## Operational

- **Quotas and rate limiting can fail open on a Redis outage** depending on the configured
  [resilience](/guides/resilience) policy. Choose fail-open vs fail-closed per dependency.
- **Read replicas have no automatic failover** and can serve stale reads. Use the
  retry-on-primary pattern. See [Read replicas](/guides/read-replicas).

## Satellite scope

- **Feature flags are boolean only.** No built-in percentage rollout; store a percentage in
  the flag's `config` and bucket on it yourself. See [Feature flags](/guides/satellites/feature-flags).
- **Metrics track a fixed counter set** (requests, errors, bandwidth), not arbitrary named
  metrics or gauges. For application telemetry use the OpenTelemetry integration. See
  [Metrics](/guides/satellites/metrics) and [Health & metrics](/guides/health).
- **Billing is not a fiscal system of record.** The payment provider (Stripe, Paddle, Lemon
  Squeezy) is the source of truth for charges, invoices, and tax; the satellite keeps a mirror
  for plan assignment, dunning, and metered billing. The opt-in fiscal features snapshot the
  provider's tax/invoice data for reporting only — no invoice numbering, no tax engine, no
  fiscal-compliance enforcement. Reconcile against your provider for accounting. See
  [Billing](/guides/satellites/billing).

## Read next

- [Roadmap](/reference/roadmap); which of these are under consideration.
- [Stability](/reference/stability); the labels and what they promise.
- [FAQ](/reference/faq); quick answers to adjacent questions.

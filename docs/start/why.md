---
title: Why Lasagna
description: Why a layered, opt-in multi-tenancy package exists in the AdonisJS world, and what makes it different from stancl/tenancy.
---

# Why Lasagna

Multi-tenancy is one of those problems that looks easy from far away. A
`tenant_id` column. A few middlewares. Done.

Then production happens.

A backfill job touches the wrong rows because someone forgot the
`WHERE`. A customer asks for their data export and you spend a weekend
writing JOIN-and-pray scripts. A tenant's connection pool exhausts and
takes down the others. A migration ships fine in dev but stalls in
production because three tenants have a stale schema. You start
writing per-tenant audit code, then per-tenant feature flags, then
per-tenant backups, then per-tenant rate limits; and six months
later you have an operational nightmare none of which is your
product.

Lasagna is the package I wish existed when I hit that wall the first
time. **It assumes you'll need every one of those things eventually**,
so it ships them on day one; but as opt-in satellites, not a
god-class.

## The metaphor that earned the name

A lasagna is the only dish I know that improves as you add layers,
provided each layer keeps to itself. Sauce, pasta, béchamel, ragù,
cheese; every layer has a job, none of them seep into the next one
unless you want them to. That is how this package thinks about
multi-tenancy:

<LasagnaCard variant="accent" title="Tenant schemas">

Each tenant lives in its own PostgreSQL schema
(`tenant_<uuid>`). Provisioned by the package, named by the package,
routed by the package. Your queries call `TenantBaseModel.query()`
and the schema switch happens before the SQL leaves your process.

</LasagnaCard>

<LasagnaCard variant="default" title="Bootstrappers">

Cache, drive, mail, session, transmit. Each bootstrapper scopes its
service to the active tenant via `AsyncLocalStorage`-aware helpers,
and queued jobs carry the same context. No threading `tenantId`
through your own plumbing.

</LasagnaCard>

<LasagnaCard variant="default" title="Operational services">

Circuit breaker, read replicas, OpenTelemetry, Prometheus, health
probes, audit logs, signed webhooks, SSO/OIDC, feature flags,
branding, quotas. The plumbing your SaaS will eventually want, in a
consistent contract.

</LasagnaCard>

<LasagnaCard variant="default" title="AdonisJS 7">

The framework everything stands on. We don't fight it; providers,
middleware, ace commands, container bindings, config. If you know
AdonisJS, you already know how to use Lasagna.

</LasagnaCard>

<LasagnaCard variant="default" title="PostgreSQL 14+">

The foundation. Schemas, Row-Level Security, and `search_path`
isolation are Postgres-native and we lean into that. PostgreSQL is the
only database we support, by design: doing one thing really well beats
spreading thin across engines.

</LasagnaCard>

## The Lasagna principle

Cut a good lasagna and the slice holds its shape. Every layer meets
the next at a clean edge, and you can lift one out without dragging
the rest along with it. The structure is in the seams.

That is the second principle of Lasagna: **clean edges**. The package
never imports your `Tenant` model; it asks the IoC container for a
`TenantRepositoryContract` and lets you bind it. The package never
hardcodes `tenant_id`; it routes through `IsolationDriver` so you
can swap schema, database, or row-scoping. The package never assumes
a queue, a cache, a mailer; every bootstrapper is opt-in and
auto-detected.

You write your app. Lasagna handles the seams.

## How we compare to stancl/tenancy

[`stancl/tenancy`](https://tenancyforlaravel.com/) is the gold
standard in the Laravel world; stable since 2019, with a dedicated
site, a book, a course, and a Discord. We owe a real debt to that
project: it set the bar for what a serious multi-tenancy package
should look like.

Lasagna covers the same ground (4 isolation drivers, 5 bootstrappers,
5 resolvers, full lifecycle hooks, imperative API) and adds the
operational surface stancl leaves to the user: a doctor command,
integrated read replicas, OpenTelemetry, Prometheus, scheduled
backups with retention tiers, the impersonation flow,
quotas-as-middleware, the REST admin API + OpenAPI 3.1 spec, and a
deep ace command surface where stancl ships a handful.

It also has gaps that stancl has filled: an admin dashboard UI, a
starter kit, an active Discord. Those are still on the roadmap.
(Billing was on this list too; it shipped in v0.2 as a Stripe
satellite.)

The table below is the same data we use internally to track our
position. Filter by category, by who-wins, or search a feature.

<ComparisonTable />

::: tip Honest about the gaps
We're not pretending to be a drop-in replacement on every axis. If
your team needs MySQL or a Nova-equivalent admin UI today, stancl is
the right call. If you need every operational lever a SaaS will
eventually want; and you're on AdonisJS 7 + PostgreSQL; Lasagna
ships more of them in one box.
:::

## What you get that you can't easily build yourself

These are the calls that take weeks of engineering when you do them
in-house, and that we already debugged:

- **Circuit breaker per tenant.** Opossum-backed, scoped to each
  tenant's database access. One bad schema can't take the others
  down with it.
- **Read replica routing.** Round-robin, random, or sticky-by-tenant.
  Connection naming is deterministic, lazy provisioning is built in.
- **Doctor command.** `tenant:doctor` with nine built-in checks
  (`backup_recency` and `backup_encryption` register when the backup
  satellite is installed), a `--fix` flag for auto-recovery, `--json` for CI
  gates, and `--watch` for a live TUI. The plugin API lets your app
  contribute checks.
- **Backups with retention tiers.** `pg_dump`, S3 mirror, JSON sidecar
  with checksums, tier-based intervals (`standard`, `premium`, …),
  per-tenant resolution.
- **REST admin API.** An OpenAPI 3.1 spec and Swagger UI. You
  bring the auth middleware; we bring the wiring.
- **Audit, webhooks, quotas, feature flags, branding, SSO, real-time
  WebSockets, metrics, impersonation, Stripe billing.** Ten satellites,
  opt-in via the configure command.
- **Compliance tooling.** Immutable audit export, GDPR
  erasure-by-anonymization, and a posture report mapped to
  SOC2/GDPR/ISO/HIPAA controls. Not a certification, but the controls and
  evidence that make passing one easier. See [Compliance](/guides/compliance).

## Hardened against the failures that bite you in production

Multi-tenancy is the kind of code where a mistake surfaces *months*
later, in production, on a Friday. So before tagging 1.0 we verified
every guarantee in the list below against real Postgres, real Redis,
real BullMQ; no mocks, no in-memory shortcuts.

- **Cross-tenant isolation under HTTP concurrency.** Interleaved
  requests across N tenants writing and reading their own rows,
  zero cross-reads, verified end-to-end.
- **Quota atomicity.** `consume()` runs inside a single Redis Lua
  script. 50 parallel callers against `limit=10` produce exactly
  ten successes and forty `QuotaExceededException`. No race window
  while Redis is up; on an outage the configurable resilience policy
  decides between availability and enforcement.
- **SSO replay protection.** OIDC `state` is consumed via atomic
  `GETDEL`; two concurrent callbacks with the same state can never
  both succeed.
- **Audit log immutability.** `tenant_audit_logs` carries Postgres
  triggers that block `UPDATE`, `DELETE`, and `TRUNCATE` from
  inside the tenant's own schema.
- **Header-vs-domain hijack.** `customDomain()` is strict by
  default: it rejects a request whose `x-tenant-id` disagrees with
  the custom-domain match, returning 400 `E_TENANT_HEADER_DOMAIN_MISMATCH`,
  not a silent override.
- **Rate-limit fails closed.** Redis down means 503, never silent
  fail-open. Opt into `failOpen: true` only if your threat model
  accepts it.
- **Identifier injection.** Every user-supplied identifier that
  reaches DDL passes `assertSafeIdentifier`. An architectural test
  fails CI if any future `rawQuery` interpolates a template variable
  without going through that helper.
- **Doctor checks against real state.** `long_running_queries`,
  `replica_lag`, `queue_health` run in CI against a live Postgres /
  BullMQ, not mocked clocks.

The list above is the *current* verification surface; every item has a spec
under [`packages/core/tests/integration/`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/packages/core/tests/integration).
If you spot a tenancy guarantee that should be on it and isn't,
[open an issue](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/issues);
the verification is iterative.

## When not to use Lasagna

Honesty is part of the pitch. Reach for something else when:

- **Your app is single-tenant, or will stay that way.** The whole
  machinery here exists to keep tenants apart. With one tenant it is
  pure overhead.
- **A single `tenant_id` column already covers you.** If your isolation
  need is a `where('tenant_id', …)` and nothing more, a thin scope in
  your own app is simpler than a package.
- **You are committed to MongoDB, MySQL, or another non-PostgreSQL
  store.** Lasagna leans on PostgreSQL schemas by design; that is the
  core strategy. If you need MySQL today, `stancl/tenancy` supports it
  now.
- **You need Express, NestJS, or another framework.** Lasagna is built
  only for AdonisJS 7 and leans on its providers, middleware, ace
  commands, and container. It does not run outside Adonis, by design.
- **You want a hosted control plane.** Lasagna is a library inside your
  AdonisJS app, not a managed service or an admin dashboard out of the
  box.

If you're on AdonisJS 7 and PostgreSQL and you expect more than one
paying tenant, it's built for you.

## What's coming next

Phase 4 of the roadmap: a public Discord, the
`@adonisjs-lasagna/dashboard` package (Inertia + Vue admin UI
consuming the OpenAPI spec), `create-lasagna-saas` (a starter kit
that wires Lasagna + Auth + Stripe), and the 1.0 release.

If you want to follow along or contribute, [the GitHub
repo](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy) is
the place. Issues are open for feature requests.

## Read next

- [Quickstart](/start/quickstart); from `npm install` to a live, schema-isolated tenant.
- [Concepts](/start/concepts); the four-layer model and how a request flows.
- [Data isolation](/guides/data-isolation/); the driver that decides where tenant data lives.
- [Comparison](/reference/comparison); the full feature-by-feature table against stancl, with a NestJS column.
- [Roadmap](/reference/roadmap); what's stable, what's experimental, and what's next.

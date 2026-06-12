---
title: Adding features later
description: Add any satellite (billing, metrics, sso, quotas, ...) after the initial install without reinstalling or losing your config. configure is additive and idempotent.
---

# Adding features later

You installed Lasagna with a couple of satellites:

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=audit,webhooks
```

Months later you want billing, or metrics, or per-tenant SSO. The
question is always the same: can you add them now without reinstalling,
and without losing the config and migrations you already have?

Yes. The `configure` command is **additive** and **idempotent**. Adding a
satellite later touches only that satellite's migrations, never the ones
you already published, and never your `config/multitenancy.ts`.

<Callout type="tip" title="Add one satellite, do not regenerate">
Pass a scoped <code>--with</code> for just the satellite you want. You
never regenerate the whole configuration, and doing so would not help:
<code>configure</code> never overwrites your config file or your tenant
model on a re-run.
</Callout>

## Why it is safe

- **Scoped publishing.** `--with=billing` resolves only the billing
  migration bundle. The migrations for satellites you installed earlier
  are never re-touched (the bundles are disjoint).
- **Your config is never overwritten.** `config/multitenancy.ts` and
  `app/models/backoffice/tenant.ts` are left alone on a re-run if they
  already exist. Any config block a new satellite needs is *printed* for
  you to paste, never injected.
- **Re-runs never duplicate a migration.** `configure` scans your
  migrations directory and skips any bundle migration that is already
  there. (A bare `configure` with no `--with` selects *every* satellite,
  so prefer a scoped `--with` to add only what you want.)

## Two kinds of satellite

How you add a satellite depends on where it lives. The
[reference table](#per-satellite-reference) below tells you which kind
each one is.

### Core satellites — just publish and migrate

`audit`, `feature_flags`, `webhooks`, `branding`, `metrics` and `quotas`
ship inside the core package. The service is already in your bundle, so
there is nothing to install. Two commands:

```bash
# Publish the migration(s) for the feature...
node ace configure @adonisjs-lasagna/saas-tenancy --with=metrics

# ...then create/extend the backoffice schema (runs the new migrations)
node ace backoffice:setup
```

That is the whole flow for a core satellite. Some print an optional
config block to paste (for example `quotas` prints a `plans` block); read
the configure output.

### Packaged satellites — install, wire, migrate

`sso` and `billing` ship as their own npm packages because they pull in
heavy peer dependencies (`jose`, `stripe`). The steps are the same plus an
install and a little wiring, all of which `configure` prints for you:

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=billing
npm install @adonisjs-lasagna/billing stripe@^18
# register the provider/commands/routes + paste the config block (see below)
node ace backoffice:setup
```

## Per-satellite reference

| Feature | `--with` | Kind | Install | Config block | Extra wiring |
|---|---|---|---|---|---|
| Audit | `audit` | core | — | — | — |
| Feature flags | `feature_flags` | core | — | — | — |
| Webhooks | `webhooks` | core | — | — | queue worker for delivery retries |
| Branding | `branding` | core | — | — | — |
| Metrics | `metrics` | core | — | optional `observability` | `/metrics` is served by `multitenancyRoutes({ metricsMiddleware })` (fail-closed) |
| Quotas | `quotas` | core | — | `plans` | `enforceQuota()` middleware on routes |
| SSO | `sso` | package | `@adonisjs-lasagna/sso` (+ optional `jose`) | — | import `SsoService` / `TenantSsoConfig` (no provider) |
| Billing | `billing` | package | `@adonisjs-lasagna/billing` + `stripe@^18` | `billing` + `plans` | provider + commands + `multitenancyBillingRoutes()` + env vars |
| RLS hardening | `rls` (opt-in) | core | — | `isolation.driver: 'rowscope-pg'` | edit the published migration, run under a non-BYPASSRLS role |
| Maintenance mode | `maintenance` (opt-in) | core | — | optional `maintenance` | migration alters the central `tenants` table |

`rls` and `maintenance` are **opt-in**: they are never published by a bare
`configure`, only when you name them with `--with`. Everything else in the
table is published when you select it (or when you run a bare `configure`).

## Example: add quotas and metrics (core satellites)

Both are core, so there is no package to install:

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=quotas,metrics
node ace backoffice:setup
```

`metrics` needs nothing else; its `/metrics` endpoint is served when you mount
`multitenancyRoutes({ metricsMiddleware: middleware.auth() })` (the operational
health routes). `/metrics` is fail-closed — it leaks tenant enumeration + KPIs,
so the call throws unless you pass `metricsMiddleware` (or `metricsMiddleware:
false` to mount it public behind a trusted network boundary). See
[Health & metrics](/docs/health). `quotas` prints a `plans` block to paste into
`config/multitenancy.ts`, then you gate routes with the middleware:

```ts
// start/routes.ts
import { enforceQuota } from '@adonisjs-lasagna/saas-tenancy/middleware'

router.post('/api/messages', [MessagesController, 'create'])
  .use(enforceQuota('apiCallsPerDay'))
```

## Example: add billing (packaged satellite)

Billing is the fullest case. Starting from an app that already has `audit`
and `webhooks`:

```bash
# 1. Publish only the billing migrations (audit/webhooks are untouched)
node ace configure @adonisjs-lasagna/saas-tenancy --with=billing

# 2. Install the package and its Stripe peer dependency
npm install @adonisjs-lasagna/billing stripe@^18
```

`configure` then prints exactly what to do. **3.** Register the provider
and commands in `adonisrc.ts`:

```ts
providers: [
  // ...
  () => import('@adonisjs-lasagna/billing/provider'),
],
commands: [
  // ...
  () => import('@adonisjs-lasagna/billing/commands'),
],
```

**4.** Mount the webhook in `start/routes.ts` and add its path to
`ignorePaths` so the tenant guard lets it through (the tenant is resolved
later from the Stripe event):

```ts
import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'
multitenancyBillingRoutes()
```

```ts
// config/multitenancy.ts
ignorePaths: ['/admin', '/health', '/webhooks/stripe'],
```

**5.** Paste the `billing` + `plans` blocks into `config/multitenancy.ts`
(the snippet is printed verbatim) and set the environment variables:

```bash
STRIPE_API_KEY=sk_test_...          # live key in production
STRIPE_WEBHOOK_SECRET=whsec_...     # from the Stripe dashboard
```

**6.** Apply the new tables:

```bash
node ace backoffice:setup
```

For the full billing journey (checkout, webhook, plan assignment) see
[Stripe + quotas](/docs/cookbook/stripe-quotas) and the
[Billing satellite](/docs/satellites/billing) reference.

## Conflicts and recovery

<Callout type="warning" title="Paste the config block yourself">
<code>configure</code> never edits <code>config/multitenancy.ts</code>. A
satellite that needs config (billing, quotas, metrics, maintenance) has
its block <em>printed</em> at the end of the run. Paste it in, then
migrate. This is intentional: host config varies too much to patch safely.
</Callout>

- **Duplicate migrations from an older version.** The idempotency guard
  ships in current releases. If a pre-guard run left two migrations for
  the same table, delete the extra file before you migrate.
- **Ordering.** Billing's `tenant_plans` is created before the `stripe_*`
  tables. The published bundle is already ordered correctly; keep that
  order if you renumber the files.
- **Your tenant model is preserved.** `app/models/backoffice/tenant.ts`
  is only written if it does not already exist.

## Secrets in tests

When you add billing, keep real Stripe keys out of the test suite:

- Inject `MockStripe` via `BillingService.__setStripeForTests(...)` for
  deterministic tests. The real SDK is never instantiated, and the keys
  in your test config can be obvious fakes (`sk_test_...`, `whsec_...`).
- Sign webhook payloads in tests with `signWebhookPayload(body, secret)`.
- Gate any real-API smoke test behind an env var (for example
  `STRIPE_TEST_API_KEY` starting with `sk_test_`) and skip it when unset,
  so CI without the secret stays green.
- Never commit live keys. Inject them in CI as secrets. PII redaction is
  on by default.

The package's own suite demonstrates this: a satellite-coexistence spec
drives every satellite for one tenant, and the example app's e2e suite
adds billing on top of the other satellites with `MockStripe`.

## Read next

- [Stripe + quotas](/docs/cookbook/stripe-quotas); the billing journey
  end to end.
- [Satellites](/docs/satellites/); the reference for each feature.
- [Installation](/docs/installation); the first-time setup this builds on.

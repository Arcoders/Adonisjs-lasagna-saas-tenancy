---
title: Tenant onboarding & offboarding
description: Orchestrate a full onboarding flow (create, seed, welcome email) and a safe offboarding flow (export, suspend, destroy) from the lifecycle hooks and commands the package already ships, without a bespoke tenant:onboard command.
---

# Tenant onboarding & offboarding

You don't need a bespoke `tenant:onboard` command. The package already ships the
pieces, `tenant:create`, `tenant:seed`, the `provision`/`destroy` hooks, and the
lifecycle events, and they compose into a complete onboarding and offboarding
flow. This recipe wires them together.

## Why a hook, not a command

`tenant:create` queues an [`InstallTenant` job](/guides/jobs#how-provisioning-flows-through-the-queue)
that provisions the schema asynchronously. A synchronous `tenant:onboard` command
could not wait for that job without reimplementing the queue. Instead, hang the
rest of onboarding off the `after:provision` hook, which the job fires once the
schema is live. Creation stays a one-liner; the hook completes the flow exactly
when the tenant is ready.

## Onboarding: seed + welcome on `after:provision`

```ts
// config/multitenancy.ts
import { defineConfig } from '@adonisjs-lasagna/saas-tenancy'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'

export default defineConfig({
  // ...
  hooks: {
    afterProvision: async ({ tenant }) => {
      // The hook runs in the InstallTenant job's context, NOT yet inside a
      // tenancy scope. Wrap tenant-scoped work in tenancy.run() so models,
      // cache, drive and logging resolve to this tenant's schema.
      await tenancy.run(tenant, async () => {
        await SeedService.run()          // starter rows in the new schema
      })

      // Side effects that don't touch the tenant schema need no scope.
      await mail.send((m) => m.to(tenant.email).subject('Welcome!').htmlView('emails/welcome', { tenant }))
    },
  },
})
```

The hook context is `{ tenant }` (a `TenantModelContract`); `provision` carries no
other fields. See [Hooks](/reference/hooks) for the full table.

::: warning before:provision runs on every retry
`before:provision` fires on **every** BullMQ attempt (the install job retries),
while `after:provision` fires only once the schema is successfully created. Keep
`before` hooks idempotent. Use `after:provision` for one-shot work like the
welcome email so a retry never sends it twice.
:::

To assign a plan as part of onboarding, call
[`QuotaService.assignPlan`](/guides/satellites/quotas) from the same hook, or set
`config.plans.getPlan` so resolution is automatic.

## Offboarding: export, then destroy

Offboarding is the mirror image, sequence an export before teardown so a
deletion is never lossy:

1. `tenant:audit:export` (and any host-side data export) while the schema is
   still live, written somewhere durable.
2. Optionally `tenant:backup` (the [backup satellite](/guides/satellites/backup))
   for a restorable snapshot.
3. `tenant:destroy` (soft-delete by default; `--keep-schema` to retain data
   during a grace period). The `before:destroy` hook is your last chance to run
   custom export or to notify downstream systems; a throw there **aborts** the
   destroy.
4. `tenant:purge-expired` later hard-drops schemas past `softDelete.retentionDays`.

```ts
// config/multitenancy.ts — last-chance export on teardown
hooks: {
  beforeDestroy: async ({ tenant }) => {
    await ExportService.archive(tenant.id)   // throw to abort the destroy
  },
}
```

For payment-driven suspension/reactivation (stop serving a non-paying tenant
without deleting it), see
[auto-suspend on payment failure](/guides/satellites/billing#auto-suspend-on-payment-failure).

## Related

- [Hooks](/reference/hooks) — the registry and both phases.
- [Background jobs](/guides/jobs) — where provisioning fires the hooks.
- [Compliance](/guides/compliance) — `tenant:audit:export` and GDPR anonymization.

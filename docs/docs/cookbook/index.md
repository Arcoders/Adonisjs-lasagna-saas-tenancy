---
title: Cookbook
description: Practical recipes that compose Lasagna's primitives; custom domains with HTTPS, Stripe-driven quotas, real-time WebSockets, multi-region replicas, custom isolation drivers, and packaging your own satellite.
---

# Cookbook

<Callout type="tip" title="Pick by goal, not by feature">
Each recipe wires multiple parts of the package toward a single
outcome. Read the section for the outcome you want; the underlying
primitives stay where they live.
</Callout>

## Recipes

| Recipe | What you get | Reach for it when |
|---|---|---|
| [Adding features later](/docs/cookbook/adding-features-incrementally) | Add any satellite after the initial install; `configure` is additive and idempotent. | You shipped on the core and now want audit, webhooks, or billing without re-scaffolding. |
| [Tenant onboarding & offboarding](/docs/cookbook/tenant-onboarding-offboarding) | Compose `afterProvision`/`beforeDestroy` hooks and lifecycle events to seed, welcome, and tear down tenants. | You need first-run setup (seed data, welcome email) or clean teardown on a tenant's lifecycle. |
| [Per-tenant worker concurrency](/docs/cookbook/per-tenant-worker-concurrency) | A dedicated BullMQ worker per tenant with its own concurrency ceiling, so one noisy tenant can't starve the others. | A tenant's job burst monopolises your shared queue workers. |
| [Custom-domain HTTPS](/docs/cookbook/custom-domain-https) | Per-tenant domains terminated by Cloudflare or cert-manager, with a wildcard fallback for the apex. | Tenants want to reach the app on their own `app.acme.com`, not just a subdomain. |
| [Stripe + quotas](/docs/cookbook/stripe-quotas) | Stripe webhook → plan assignment → quota middleware, atomic and idempotent. | A paid plan should raise or lower a tenant's limits automatically. |
| [Multi-tenant WebSockets](/docs/cookbook/multi-tenant-websockets) | Tenant-isolated socket.io rooms with per-event tenant context. | You need real-time features (live dashboards, chat, presence) scoped per tenant. |
| [Multi-region replicas](/docs/cookbook/multi-region-replicas) | Round-robin / random / sticky-by-tenant read strategies, plus the doctor's `replica_lag` check. | Read traffic outgrows one primary, or your tenants are geographically spread. |
| [Custom isolation driver](/docs/cookbook/custom-isolation-driver) | Implement `IsolationDriver` from scratch; the registry takes anything that satisfies the contract. | None of the four shipped drivers match your storage shape. |
| [Creating a satellite](/docs/cookbook/creating-a-satellite) | Package your own opt-in feature so it installs through `configure --with=` like the built-ins. | You want to ship reusable tenant functionality as its own versioned package. |

## Read next

- [Bootstrappers](/docs/bootstrappers/); what runs around every
  request.
- [Doctor](/docs/commands#doctor); the operational health command.

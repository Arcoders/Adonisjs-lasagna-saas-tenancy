---
title: Cookbook
description: Practical recipes that compose Lasagna's primitives; custom domains with HTTPS, Stripe-driven quotas, multi-region replicas, custom isolation drivers.
---

# Cookbook

<Callout type="tip" title="Pick by goal, not by feature">
Each recipe wires multiple parts of the package toward a single
outcome. Read the section for the outcome you want; the underlying
primitives stay where they live.
</Callout>

## Recipes

| Recipe | What you get |
|---|---|
| [Adding features later](/docs/cookbook/adding-features-incrementally) | Add any satellite after the initial install. `configure` is additive and idempotent. |
| [Custom-domain HTTPS](/docs/cookbook/custom-domain-https) | Per-tenant domains terminated by Cloudflare or cert-manager. Wildcard fallback for the apex. |
| [Stripe + quotas](/docs/cookbook/stripe-quotas) | Stripe webhook → plan assignment → quota middleware. Atomic, idempotent. |
| [Multi-region replicas](/docs/cookbook/multi-region-replicas) | Round-robin / random / sticky-by-tenant strategies, plus the doctor's `replica_lag` check. |
| [Custom isolation driver](/docs/cookbook/custom-isolation-driver) | Implement `IsolationDriver` from scratch; the registry takes anything that satisfies the contract. |

## Read next

- [Bootstrappers](/docs/bootstrappers/); what runs around every
  request.
- [Doctor](/docs/commands#doctor); the operational health command.

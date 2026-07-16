---
title: 'Tutorial: build a multi-tenant SaaS'
description: A guided, five-step path that builds a real multi-tenant helpdesk on Lasagna — setup, tenants, per-tenant users, Stripe billing, and fleet-wide reporting.
---

# Tutorial: build a multi-tenant SaaS

This is the guided path. Over five steps you build **Helpdesk**, a small but real
multi-tenant SaaS where each customer company gets its own isolated set of users and
support tickets, pays for a plan, and feeds a fleet-wide usage dashboard. Every step
produces a working artifact the next step builds on.

If you want the ten-minute speed run instead, take the
[Quickstart](/start/quickstart). If you want the exhaustive reference for a single
topic, each step links into the deep [Guides](/guides/tenant-identification). This
tutorial is the spine that threads them together with one example you can actually run.

## What you'll build

| Step | You add | You learn |
|---|---|---|
| [1. Setup](/start/tutorial/setup) | The package, three connections, the tenant repository | How the moving parts wire together |
| [2. Tenants](/start/tutorial/tenants) | Your first tenant and a tenant-scoped `Ticket` model | Provisioning and schema-routed queries |
| [3. Users & auth](/start/tutorial/users) | A per-tenant `User` model behind your auth | Authentication that routes to the right schema |
| [4. Billing](/start/tutorial/billing) | Stripe checkout, `starter`/`pro` plans, a ticket quota | Subscriptions driving plan limits |
| [5. Reporting](/start/tutorial/reporting) | A `tickets_opened` metric and a usage dashboard | Isolation-safe cross-tenant analytics |

By the end, a request to `POST /tickets` resolves the calling tenant, authenticates a
user inside that tenant's schema, checks the tenant's plan quota, writes the ticket into
the tenant's own Postgres schema, and counts it toward a dashboard that ranks every
tenant by usage. No `where('tenant_id', …)` anywhere in your code.

## Prerequisites

<Callout type="tip" title="Before you start">
A running <strong>PostgreSQL 14+</strong> and <strong>Redis 6+</strong>, an AdonisJS 7
app on <strong>Node 24+</strong>, and a <a href="https://dashboard.stripe.com">Stripe</a>
test account for step 4. The full requirements matrix lives in
<a href="/start/installation">Installation</a>.
</Callout>

You do not need to have read the rest of the docs first. Each step introduces what it
uses and links out for depth, so you can follow straight through and come back later.

## The mental model

One idea underpins everything you're about to build: **the layer a model extends decides
the schema its queries hit.** Tenant data lives in per-tenant Postgres schemas, the tenant
registry and satellite data live in a shared `backoffice` schema, and product-wide data
lives in the central `public` schema. You never route a query by hand; you pick a base
class. [Concepts](/start/concepts) covers the full four-layer model, and you'll see all of
it in practice across the next five pages.

## Read next

- [Step 1: Setup](/start/tutorial/setup); install the package and wire the three connections.

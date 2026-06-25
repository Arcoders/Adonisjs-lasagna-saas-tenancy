---
title: Introduction
description: Why Lasagna exists, what it solves, and the principles that shape its API.
---

# Introduction

`@adonisjs-lasagna/saas-tenancy` is a schema-based PostgreSQL
multi-tenancy package for AdonisJS 7. It assumes you'll need every
piece of operational plumbing a real SaaS eventually wants (circuit
breakers, replicas, audit logs, webhooks, backups, SSO, quotas,
Stripe billing) and ships them as opt-in satellites instead of a
god-class.

<Callout type="tip" title="One sentence">
Each tenant lives in its own PostgreSQL schema. Everything else
(cache, drive, mail, queue, session, broadcasts) is scoped
automatically through `AsyncLocalStorage`. You write your app.
Lasagna handles the seams.
</Callout>

## What you get

- **Four isolation drivers**: `schema-pg` (default), `database-pg`,
  `rowscope-pg`, `sqlite-memory`. Pluggable through a single contract.
- **Five bootstrappers**: cache, drive (filesystem), mail, session,
  broadcasting. Each scoped to the active tenant via
  `AsyncLocalStorage`. Database routing is handled by the active
  isolation driver itself, not as a separate bootstrapper.
- **Ten satellites**: audit logs, feature flags, webhooks,
  branding, SSO, real-time WebSockets, metrics, quotas, impersonation,
  Stripe billing. None required, all consistent.
- **Operational kit**: `tenant:doctor` (nine built-in checks, plus
  `backup_recency` with the backup satellite, `--fix`,
  `--watch`, `--json`), backups with retention tiers, read replicas,
  Prometheus, OpenTelemetry, health probes, and a per-dependency
  fail-open/fail-closed resilience policy.
- **A full suite of ace commands** spanning provisioning, migrations,
  backups, cloning, exec-under-tenant, maintenance mode, REPL, billing.
- **REST admin API** with an OpenAPI 3.1 spec and Swagger UI.

## What you *don't* get (yet)

- An admin dashboard UI. Only the REST API. The Inertia + Vue
  dashboard is on the post-1.0 roadmap.
- A starter kit. `create-lasagna-saas` is roadmap, not shipping.

## Read next

- [Tutorial: build a SaaS](/start/tutorial/). The guided path that
  builds a real multi-tenant helpdesk in five steps, from setup to a
  fleet-wide usage dashboard.
- [Concepts](/start/concepts). The four layers (Central, Backoffice,
  Tenant, Satellites) and how they fit.
- [Installation](/start/installation). `npm install` to a live
  tenant in five minutes.
- [Why Lasagna](/start/why). The longer story, including a feature
  comparison vs `stancl/tenancy`.

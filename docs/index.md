---
layout: home
title: Production multi-tenancy for AdonisJS
description: Schema-isolated PostgreSQL tenants with the production plumbing your SaaS will eventually need; circuit breakers, queues, plans, backups, replicas, audit logs, webhooks, SSO, Stripe billing. One package.

features:
  - icon:
      src: /icons/shield.svg
      wrap: true
      width: 30
      height: 30
    title: Schema-isolated tenants
    details: Each tenant lives in its own PostgreSQL schema. No tenant_id leaks into your queries, and a cross-tenant read throws instead of returning the wrong rows.
  - icon:
      src: /icons/puzzle.svg
      wrap: true
      width: 30
      height: 30
    title: Four isolation drivers
    details: schema-pg, database-pg, rowscope-pg, and an in-memory SQLite driver for tests. One contract, swapped with a single config line.
  - icon:
      src: /icons/lightning.svg
      wrap: true
      width: 30
      height: 30
    title: Context that follows the request
    details: Cache, drive, mail, sessions, broadcasts, and queued jobs all resolve the active tenant through AsyncLocalStorage. Nothing to thread by hand.
  - icon:
      src: /icons/stethoscope.svg
      wrap: true
      width: 30
      height: 30
    title: Operations built in
    details: A doctor command that fixes things, scheduled backups with retention tiers, restore, clone, and a REST admin API described by an OpenAPI spec.
  - icon:
      src: /icons/satellite.svg
      wrap: true
      width: 30
      height: 30
    title: Satellites when you need them
    details: Audit logs, feature flags, signed webhooks, branding, SSO, metrics, quotas, and Stripe billing. Each one opts in per tenant.
  - icon:
      src: /icons/database.svg
      wrap: true
      width: 30
      height: 30
    title: Ready for production
    details: Circuit breakers, read replicas, health probes, Prometheus metrics, and OpenTelemetry spans. A Dockerfile, docker-compose, and Helm chart ship with it.
---

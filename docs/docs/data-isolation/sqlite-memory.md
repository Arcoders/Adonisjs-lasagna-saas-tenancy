---
title: sqlite-memory driver
description: In-process SQLite per tenant. Tests only; vanishes on process exit. Useful for hermetic unit tests.
---

# `sqlite-memory` driver

<Callout type="warning" title="Tests only">
This driver writes to <code>:memory:</code>. Data does not survive a
process exit. Never enable it in production; Lasagna will not stop
you, but the next deploy wipes every tenant.
</Callout>

## What it does

Each tenant gets an in-memory SQLite database for the life of the
process. Useful for hermetic unit tests where spinning up PostgreSQL
is overkill.

## Configuration

```ts
// config/multitenancy.ts (test environment only)
export default defineConfig({
  isolation: {
    driver: 'sqlite-memory',
  },
})
```

## When to use it

- Unit tests that exercise tenant-scoped model logic without needing
  a real Postgres.
- Documentation snippets you want to run as test fixtures.
- Quick CI smoke runs.

## Limits

- No `JSONB`, no `array` columns, no PG-specific extensions.
- Migrations need to be SQLite-compatible; that often means avoiding
  PG-only syntax.
- Concurrency story is single-writer.

## Better choice for most tests

Lasagna's [`testing/`](/docs/testing) helpers (`buildTestTenant`,
`MockTenantRepository`, `setRequestTenant`) rarely need a real
database at all; they let you assert tenant-routing behaviour
without touching SQL. Reach for this driver only when your assertion
needs the database round-trip.

---
title: Contributing
description: How to set up the dev environment, run tests, file issues, and propose changes.
---

# Contributing

<Callout type="tip" title="The short version">
Open an issue first, ship a PR with tests, expect a review within a
week. Multi-tenancy bugs are subtle; concrete reproductions move
twice as fast as long descriptions.
</Callout>

## Dev environment

```bash
git clone https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy.git
cd Adonisjs-lasagna-saas-tenancy
npm install
npm run typecheck
npm run test           # unit tests against source
npm run test:integration  # builds + runs integration tests against ./build/
```

The integration suite runs against real PostgreSQL and Redis. The
fastest way to bring those up is the example app's compose file
(Postgres on 55432, Redis on 56379; the test fixtures point at those
ports already):

```bash
cd examples/api && docker compose up -d && cd ../..
```

## Running a single test

The repo uses Japa. Filter by file or test name:

```bash
npm run test -- --files tests/@guarantees/behavior/unit/behavior_telemetry_service.spec.ts
npm run test -- --tests "resolves tenant id from header"
```

## Style and tooling

- ESLint config in `eslint.config.js` (extends
  `@adonisjs/eslint-config`).
- Prettier uses `@adonisjs/prettier-config`.
- No npm scripts for either; run `npx eslint` / `npx prettier`
  directly.

## Diagram conventions

The docs use Mermaid, inline in the markdown, and nothing else. No new
visualization dependencies, no exported images for technical diagrams
(they can't be diffed, so they drift). Rules for adding or changing one:

- A diagram is a view, never a source. It may only restate facts already
  present in the surrounding prose, tables, or linked code. If a fact
  exists only in a diagram, that's a doc bug.
- Label nodes with real identifiers (`InstallTenant`,
  `E_TENANT_NOT_READY`, `past_due`), never invented shorthand, so grep
  finds them and doc audits can verify them like prose.
- One diagram per page is the norm, two is the cap. Keep them under
  roughly 12 nodes and 4 sequence actors; needing more means the page
  needs restructuring.
- Precede every diagram with a one-sentence prose caption stating its
  takeaway, so screen readers and skimmers lose nothing.
- No per-diagram styling; inherit the global mermaid config so light and
  dark mode keep working for free.

When you change one of these areas, re-check the matching diagram:
tenant resolution (`tenant_adapter.ts`, the resolver registry) →
Tenant identification; provisioning (`install_tenant.ts`,
`hook_registry.ts`) → Background jobs; tenant states
(`TenantStatus`, `tenant_guard_middleware.ts`) → Lifecycle events;
`sso_service.ts` → SSO; the Stripe dispatcher/job/replay → Billing;
`deploy/docker-compose.prod.yml` → Deployment.

## File names and exports

- `snake_case` files, `PascalCase` classes, default-exported.
- TypeScript imports use `.js` extensions (`module: NodeNext`).
- Public surface lives behind explicit subpath exports; when adding
  a new entry point, update both `exports` and `typesVersions` in
  `package.json`.

## Tests are mandatory

PRs without tests bounce. The package's invariants; tenant
isolation, identifier validation, cache namespacing; are exactly
the kind of thing that breaks silently. The doctor command finds
breakage in production; tests find it before production.

If you don't know how to write the test, open the PR with a TODO
and ask. Reviewers will help.

## Filing issues

Reproducible bug reports save hours. The template asks for:

- The package version (`package.json` `version`).
- A minimal AdonisJS 7 project showing the bug, or a copyable code
  snippet against the `examples/api` reference app.
- The actual vs expected behaviour.

Vague reports ("queue worker doesn't pick up jobs") are hard to
action. Concrete reproductions ("when I dispatch InstallTenant from
the configure hook, the worker logs 'no handler' for that
tenant_id") get fixed in a single round trip.

## Roadmap

The current focus areas live on the
[GitHub project board](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/projects).
Top-level themes:

- **1.0 release**; finalise APIs, ship the public site,
  community channels.
- **Dashboard package**; `@adonisjs-lasagna/dashboard` consuming
  the OpenAPI spec, Inertia + Vue.
- **Starter kit**; `create-lasagna-saas` wiring Lasagna + Auth +
  Stripe.

## Code of conduct

Be the kind of contributor you'd want to work with. Respect time
zones, assume good faith, default to written explanations over
short replies. Reviews are about the code, not the author.

## License

MIT. Contributing means agreeing your contributions ship under MIT.

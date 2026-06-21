---
title: Stability
description: What "stable", "release candidate" and "experimental" mean across the Lasagna packages, and what the 1.x semver promise covers.
---

# Stability

This package is broad: a tenancy core plus four satellite packages and a set of
optional in-core features. A project this wide, maintained by one person, cannot
honestly call its whole surface "production ready" at once. So every feature
carries an explicit stability label, and the 1.x semver promise is scoped to
what those labels say. This page is the canonical source. The per-package
READMEs and the npm pages mirror it.

## The labels

| Label | Meaning |
|---|---|
| **Stable** | Production ready and covered by the full semver promise below. A breaking change ships only in a new major. **Nothing carries this label yet** (see the criteria). |
| **Release candidate** | Feature complete, green in CI against real Postgres and Redis, and hardened against the isolation failure modes we test for. The API is considered final. It is *not* yet `stable` because two things are still open: an independent security review and real production mileage. Until those close, a corrective breaking change inside a 1.x minor remains possible. |
| **Experimental** | Works and is tested, but the surface may change or break in any minor release. Not covered by the semver promise. Use it, but pin your version and read the changelog before upgrading. |

## What `stable` requires

A feature is promoted to `stable` only when all three hold at once:

1. **Real integration green in CI** against Postgres and Redis (and the relevant
   external dependency, for satellites). This is true for the core today.
2. **Covered by an independent security review** focused on isolation (see the
   [security guide](/security)). Not done yet.
3. **Production mileage**: weeks of real traffic with no open isolation
   incident. Not done yet.

The isolation core meets (1) today and is the immediate candidate for `stable`.
It moves to `stable` the moment (2) and (3) close, within the 1.x line and
without a major bump. The satellites stay `experimental` until each clears the
same bar on its own.

## The 1.x semver promise

- **Stable** surfaces follow semver strictly: a breaking change to a documented,
  stable API only ever ships in a new major (`2.0.0`).
- **Release candidate** surfaces are intended to follow semver and the API is
  frozen, with one honest caveat: if the pending security review or production
  mileage forces a correction, it may land in a 1.x minor with a loud changelog
  entry and a migration note. We do not expect this, but the `release-candidate`
  label exists precisely so the promise is not overstated before external eyes
  and real traffic.
- **Experimental** surfaces are excluded from the promise. They may change in any
  minor. Breaking changes are still called out in the changelog, but they are not
  gated behind a major.

Deprecations: where a removed surface had its own subpath (the `/admin` entry
point is the precedent), it first becomes a throwing shim with a migration hint
for one minor, then drops at the next major. Symbols that lived in a shared
barrel (the SSO/billing/backup exports the 1.0 split moved out) are removed
outright: TypeScript users get a compile error pointing at the import, plain-JS
users get `undefined` at the import site; check the upgrade guide's symbol map
when an import stops resolving.

### What the Satellite ABI freeze covers

Now that the `/sdk` surface is `release candidate`, `SATELLITE_API_VERSION = 1`
is a frozen contract. Concretely, the 1.x promise covers three things a satellite
relies on: the core registries a satellite self-registers into (provider,
commands, migrations discovery), the `lasagnaSatellite` manifest shape the
configure toolkit reads, and the `SatelliteProviderContract` / configure-toolkit
signatures exported from `/sdk`. A change that would break a satellite built
against version 1 does not land in a minor; it ships as a `SATELLITE_API_VERSION`
bump, and `checkSatelliteApiCompat` fails loudly when a satellite expects a newer
ABI than the installed core provides. This is what lets the satellites below sit
on `release candidate` ground rather than on a contract that could move under them.

## Feature stability matrix

### Core (`@adonisjs-lasagna/saas-tenancy`)

The isolation substrate. Everything here is **release candidate** unless noted.

| Feature | Stability | Notes |
|---|---|---|
| Schema isolation (`schema-pg`) | Release candidate | Default driver. |
| Database isolation (`database-pg`) | Release candidate | One database per tenant. |
| Row-scope isolation (`rowscope-pg`) | Release candidate | Ship the `--with=rls` migration for the SQL-level backstop; see [rowscope-pg](/docs/data-isolation/rowscope-pg). |
| `sqlite-memory` driver | Testing only | For tests; never for production. |
| Custom isolation driver API (`IsolationDriver` + `IsolationDriverRegistry`) | Release candidate | Public extension point for additional backends. The seam a future MySQL satellite registers through. |
| Packaged-satellite SDK (`/sdk`: `SatelliteManifest`, `SatelliteProviderContract`, configure toolkit, `SATELLITE_API_VERSION`) | Release candidate | Public extension point for third-party satellites. The *Satellite ABI* it commits to (the core registries a satellite self-registers into, the manifest shape, the configure contract) is now frozen and contract-tested, so `SATELLITE_API_VERSION = 1` is a stable contract under the 1.x promise. An incompatible ABI change ships as a `SATELLITE_API_VERSION` bump, which `checkSatelliteApiCompat` rejects against an older core, never as a silent break inside a minor. See [Creating a satellite](/docs/cookbook/creating-a-satellite). |
| Tenant resolution (subdomain / path / header) | Release candidate | Always via `resolveTenantId()`. |
| `TenantAdapter` + base-model routing | Release candidate | |
| Connection LRU, budget, optional hard cap | Release candidate | `enforceConnectionCap` defaults `false`; see [scaling limits](/docs/scaling-limits). |
| Circuit breaker | Release candidate | OPEN state restored from Redis across restarts. |
| Dependency resilience (`ResilienceService`, 503 fail-closed) | Release candidate | A resolved tenant whose DB is down returns a typed 503, never central. |
| Contextual logging (`AsyncLocalStorage`) | Release candidate | |
| Tenant lifecycle (provision / migrate), hooks, lifecycle events | Release candidate | |
| Soft delete + recycle bin | Release candidate | |
| Health probes (`/livez`, `/readyz`, `/healthz`) | Release candidate | |
| Doctor (base checks) | Release candidate | |
| Plans and quotas (`enforceQuota`) | Experimental | Opt-in feature, not part of the isolation guarantee. |
| Read-replica routing | Experimental | No automatic failover by design; use the retry-on-primary pattern in [read replicas](/docs/read-replicas). |
| Audit logs | Experimental | Satellite (in core). |
| Webhooks | Experimental | Satellite (in core). |
| Branding | Experimental | Satellite (in core). |
| Feature flags | Experimental | Satellite (in core). |
| Metrics (`/metrics`, per-tenant Prometheus) | Experimental | Satellite (in core). |
| Impersonation | Experimental | Satellite (in core). |

### Satellite packages

| Package | Stability | Surface |
|---|---|---|
| `@adonisjs-lasagna/admin` | Release candidate | REST admin API + OpenAPI + Swagger. |
| `@adonisjs-lasagna/sso` | Release candidate | Per-tenant OIDC / SSO. |
| `@adonisjs-lasagna/billing` | Release candidate | Multi-provider billing pipeline (Stripe / Paddle / Lemon Squeezy). |
| `@adonisjs-lasagna/backup` | Release candidate | Backup / restore / clone / SQL import. |
| `@adonisjs-lasagna/websockets` | Release candidate | Multi-tenant bidirectional WebSockets on socket.io. |

The version number says the same thing the label does: a `release candidate`
satellite is published as `>=1.0.0`, so the version string a consumer reads off
npm matches the semver promise this page makes. CI enforces the agreement
mechanically: `scripts/check-stability-versions.mjs` parses this page, and
`scripts/check-satellite-graduation.mjs` verifies each satellite meets the
graduation gate (coverage gate, manifest, configure hook, CHANGELOG, doc page,
version) before it can carry the `release candidate` label.

Each satellite cleared the same graduation bar: an own coverage gate
(`.c8rc.json`) with unit tests over its security-critical core, an
auto-describable `lasagnaSatellite` manifest at the frozen Satellite ABI
(`satelliteApi: 1`), green `publint` + `arethetypeswrong`, a doc page, and a
CHANGELOG. As with the core, `release candidate` (not `stable`) reflects the two
still-open items: an independent security review and production mileage.

## How to read this if you are adopting

- Want true tenant isolation and nothing else? You are on `release-candidate`
  ground: the core. Pin the version, follow the [deployment](/docs/deployment)
  and [security](/security) guides, and you are leaning only on what is tested
  and gated in CI.
- Reaching for a satellite (billing, SSO, admin, backup, quotas, webhooks, and
  the rest)? Treat it as `experimental`: it works and is covered by tests, but
  pin the version and read the changelog before each upgrade.
- Watch this page. As the security review and production mileage close, the core
  moves to `stable` and the matrix is updated in the same change.

## Read next

- [Roadmap](/docs/roadmap); what unblocks `stable` and what is next.
- [Known limitations](/docs/known-limitations); the intentional non-goals.
- [Upgrade to 1.0](/docs/upgrade-to-1.0); the mechanical migration from 0.x.

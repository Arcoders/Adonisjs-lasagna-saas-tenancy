---
title: Stability
description: What "stable", "release candidate" and "experimental" mean across the Lasagna packages, and what the semver promise covers.
---

# Stability

This package is broad: a tenancy core plus five satellite packages and a set of
optional in-core features. A project this wide, maintained by one person, cannot
honestly call its whole surface "production ready" at once. So every feature
carries an explicit stability label, and the semver promise is scoped to what
those labels say. This page is the canonical source. The per-package READMEs and
the npm pages mirror it.

Everything is pre-1.0 today. The core ships `0.3.0`; the five satellites ship
`0.1.0`. Under semver a `0.x` package promises nothing across minors, which is
the honest reading of a project with no production mileage behind it. `1.0.0` is
earned, not declared.

## The labels

| Label | Meaning |
|---|---|
| **Stable** | Production ready and covered by the full semver promise below. A breaking change ships only in a new major. Requires a `>=1.0.0` version. **Nothing carries this label yet** (see the criteria). |
| **Release candidate** | Feature complete, green in CI against real Postgres and Redis, and hardened against the isolation failure modes we test for. The API is considered final. It is *not* yet `stable` because two things are still open: an independent security review and real production mileage. The label describes maturity, not a version floor: a `0.x` release candidate is the more conservative pairing, and that is where the core sits today. |
| **Experimental** | Works and is tested, but the surface may change or break in any minor release. Not covered by the semver promise. Use it, but pin your version and read the changelog before upgrading. |

## What `stable` requires

A feature is promoted to `stable` only when all three hold at once:

1. **Real integration green in CI** against Postgres and Redis (and the relevant
   external dependency, for satellites). This is true for the core today.
2. **Covered by an independent security review** focused on isolation (see the
   [security guide](/guides/security)). Not done yet.
3. **Production mileage**: weeks of real traffic with no open isolation
   incident. Not done yet.

The isolation core meets (1) today and is the immediate candidate for `stable`.
It reaches `1.0.0` when (2) and (3) close. The satellite **packages** cleared the
same engineering bar in CI, but none of them has ever been published, let alone
run in production, so they ship `0.1.0` and carry the `experimental` label until
real usage says otherwise. The in-core opt-in **features** stay `experimental`
until each clears the graduation bar on its own.

## The semver promise

- **Stable** surfaces follow semver strictly: a breaking change to a documented,
  stable API only ever ships in a new major (`2.0.0`). Nothing is stable yet.
- **Release candidate** surfaces have a frozen API and are intended to follow
  semver once the package reaches `1.0.0`. Today the core is `0.3.0`, so semver
  formally promises nothing across a minor. In practice a breaking change to the
  core lands with a loud changelog entry and a migration note, and the
  `release candidate` label exists precisely so the promise is not overstated
  before external eyes and real traffic.
- **Experimental** surfaces are excluded from the promise. They may change in any
  minor. Breaking changes are still called out in the changelog, but they are not
  gated behind a major.

Deprecations: a removed surface is dropped from the `exports` map, so importing
it fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`. There is no throwing shim; the
`/admin` entry point moved to its own package this way. Symbols that lived in a
shared barrel (the SSO/billing/backup exports the satellite split moved out) are
removed outright: TypeScript users get a compile error pointing at the import,
plain-JS users get `undefined` at the import site; check the upgrade guide's
symbol map when an import stops resolving. Once the core reaches `1.0.0`, a
removal will first ship deprecated for one minor.

### What the Satellite ABI freeze covers

`SATELLITE_API_VERSION = 1` is a frozen contract, and it is versioned separately
from the npm package: the core can go from `0.3.0` to `1.0.0` without the ABI
moving, and the ABI can bump without a major. It covers three things a satellite
relies on: the core registries a satellite self-registers into (provider,
commands, migrations discovery), the `lasagnaSatellite` manifest shape the
configure toolkit reads, and the `SatelliteProviderContract` / configure-toolkit
signatures exported from `/sdk`. A change that would break a satellite built
against version 1 ships as a `SATELLITE_API_VERSION` bump, and
`checkSatelliteApiCompat` fails loudly when a satellite expects a newer ABI than
the installed core provides. That is what lets a satellite stand on solid ground
even while the core's own version is still `0.x`.

## Public subpath surface (keep vs. hide)

The core publishes 20 `exports` subpaths. `/base-models`, `/middleware`,
`/events`, `/exceptions`, `/types`, `/jobs`, `/models/satellites`, `/mixins`,
`/config`, `/testing`, `/commands` and `/providers/multitenancy_provider` are the
documented, app-facing surfaces. Four more are an **advanced tier** (see below).
The rest are low-level entry points that exist because a satellite or an advanced
host reached for one primitive without wanting the whole barrel.

| Subpath | Decision | Why |
|---|---|---|
| `/signals` | **Keep** (low-level) | The provisioning-signal helpers a satellite `after:provision` hook uses. Kept for satellite authors. |
| `/base-models` | **Keep** | The three base models. The root barrel re-exports them, and the two adapters, for the common case. |
| `/safe-fetch` | **Keep** | The DNS-pinned egress helper — a first-class security primitive a host or satellite SHOULD use for any attacker-influenced fetch. Documented, not merely low-level. |
| `/services`, `/health`, `/sdk`, `/plugin` | **Advanced** (minor-breakable) | Everything a custom driver, resolver, bootstrapper, health check or plugin author needs. Broad and close to the internals: symbols here may change in a **minor**, and the deprecation path below does not cover them. An app that only wires tenants never imports from these. |
| `/internal` | **Hide** (unstable) | Not part of the stable API. Published only so first-party satellites can import app.booted-safe helpers from a bare unit runner; see the stability policy in `src/internal.ts`. It carries the AEAD envelope primitives and the SSRF URL guards. `backup`, `ai` and `satellite-test-kit` import it, as do core's own integration specs. Anything a third party legitimately needs also lives on a stable surface (`/sdk`, `/services`, `/testing`). |

Keep-labelled subpaths carry the stability of the symbols they expose (all
`release candidate` today) and are removed only through the deprecation path
above. `/internal` and the advanced tier are the exclusions.

### De-listed before the first release

Five subpaths were removed from `exports` while the package still had no
published consumers, so nothing had to break to shrink the promise. Each symbol
they carried is still reachable:

| Was | Now |
|---|---|
| `/crypto` | The AEAD envelope primitives moved to `/internal`. A host stores a secret through `readSecret` / `writeSecret` / `SECRET_CLASS` on the root barrel and never composes the envelope itself; the first-party `crypto` satellite reaches the `sealV2WithKey` / `openV2WithKey` seam through `/internal`. |
| `/worm-ledger` | Removed from the public surface. The append-only hash-chain writer moved to `/internal`, where the first-party `crypto` satellite's shred audit composes it; it is not a general-purpose logging API. |
| `/adapters` | `DefaultLucidAdapter` and `TenantAdapter` are on the root barrel; the unused `BackofficeAdapter` was removed (the unified `TenantAdapter` routes backoffice models by their `static isolation` marker). |
| `/helpers` | `buildTenantWorkerOptions` is on the root barrel. |
| `/extensions/request` | `resolveTenantId` is on the root barrel. The module's `__*ForTests` seams are no longer public at all. |

## Feature stability matrix

### Core (`@adonisjs-lasagna/saas-tenancy`)

The isolation substrate. Everything here is **release candidate** unless noted.

| Feature | Stability | Notes |
|---|---|---|
| Schema isolation (`schema-pg`) | Release candidate | Default driver. |
| Database isolation (`database-pg`) | Release candidate | One database per tenant. |
| Row-scope isolation (`rowscope-pg`) | Release candidate | Ship the `--with=rls` migration for the SQL-level backstop; see [rowscope-pg](/guides/data-isolation/rowscope-pg). |
| `sqlite-memory` driver | Testing only | For tests; never for production. |
| Custom isolation driver API (`IsolationDriver` + `IsolationDriverRegistry`) | Release candidate | Public extension point for custom isolation strategies a host builds itself. Lasagna ships PostgreSQL drivers only. |
| Packaged-satellite SDK (`/sdk`: `SatelliteManifest`, `SatelliteProviderContract`, configure toolkit, `SATELLITE_API_VERSION`) | Release candidate | Public extension point for third-party satellites. The *Satellite ABI* it commits to (the core registries a satellite self-registers into, the manifest shape, the configure contract) is now frozen and contract-tested, so `SATELLITE_API_VERSION = 1` is a stable contract under the 1.x promise. An incompatible ABI change ships as a `SATELLITE_API_VERSION` bump, which `checkSatelliteApiCompat` rejects against an older core, never as a silent break inside a minor. See [Creating a satellite](/guides/cookbook/creating-a-satellite). |
| Tenant resolution (subdomain / path / header) | Release candidate | Always via `resolveTenantId()`. |
| `TenantAdapter` + base-model routing | Release candidate | |
| Connection LRU, budget, optional hard cap | Release candidate | `enforceConnectionCap` defaults `false`; see [scaling limits](/guides/scaling-limits). |
| Circuit breaker | Release candidate | In-memory and per-tenant; survives a Redis outage. See [resilience](/guides/resilience#the-tenant-circuit-breaker). |
| Dependency resilience (`ResilienceService`, 503 fail-closed) | Release candidate | A resolved tenant whose DB is down returns a typed 503, never central. |
| Contextual logging (`AsyncLocalStorage`) | Release candidate | |
| Tenant lifecycle (provision / migrate), hooks, lifecycle events | Release candidate | |
| Soft delete + recycle bin | Release candidate | |
| Health probes (`/livez`, `/readyz`, `/healthz`) | Release candidate | |
| Doctor (base checks) | Release candidate | |
| Plans and quotas (`enforceQuota`) | Experimental | Opt-in feature, not part of the isolation guarantee. |
| Plugin platform (`definePlugin`, request-path seams, capability registry, trust controls) | Experimental | Opt-in extension surface for third-party satellites. The in-process trust controls are friction, not a sandbox; the read-only role is the boundary. See [plugins](/guides/plugins) and the [security guide](/guides/security). |
| Read-replica routing | Experimental | No automatic failover by design; use the retry-on-primary pattern in [read replicas](/guides/read-replicas). |
| Audit logs | Experimental | Satellite (in core). |
| Webhooks | Experimental | Satellite (in core). |
| Branding | Experimental | Satellite (in core). |
| Feature flags | Experimental | Satellite (in core). |
| Metrics (`/metrics`, per-tenant Prometheus) | Experimental | Satellite (in core). |
| Impersonation | Experimental | Satellite (in core). |

### Satellite packages

| Package | Stability | Surface |
|---|---|---|
| `@adonisjs-lasagna/sso` | Experimental | Per-tenant OIDC / SSO. |
| `@adonisjs-lasagna/billing` | Experimental | Multi-provider billing pipeline (Stripe / Paddle / Lemon Squeezy). |
| `@adonisjs-lasagna/backup` | Experimental | Backup / restore / clone / SQL import. |
| `@adonisjs-lasagna/reporting` | Experimental | Cross-tenant analytics over the backoffice `tenant_metrics` table, custom named metrics, and host-defined report extensions. |
| `@adonisjs-lasagna/ai` | Experimental | Per-tenant AI streaming gateway: the streaming spine, a pluggable provider contract (Claude / DeepSeek / Kimi), and per-chunk cost metering over the kernel rails. |
| `@adonisjs-lasagna/crypto` | Experimental | Field-level encryption: per-(subject × category) DEKs wrapped under a pluggable KeyProvider (env / AWS KMS / HashiCorp Vault), a deterministic search HMAC, and O(1) crypto-shredding gated on governance and audited to the WORM ledger. |

All five ship `0.1.0`: the first published version of each. They peer-depend on
the core with the range `>=0.3.0 <1.0.0`, so any `0.x` core satisfies them.

Two more packages live in the repository but are **not published to npm**, so they
carry no stability promise at all: `@adonisjs-lasagna/admin` (the REST admin API)
and `@adonisjs-lasagna/websockets`. Their guides say so in a banner. Vendor them or
depend on a git reference; `npm install` will 404.

The version number says the same thing the label does: an `experimental` package
is published as `0.x`, so the version string a consumer reads off npm matches the
promise this page makes. CI enforces the agreement mechanically:
`scripts/check-stability-versions.mjs` parses this page and fails on any label
that contradicts a version, or on any README badge that contradicts the table.
`scripts/check-satellite-graduation.mjs` verifies the graduation gate (coverage
gate, merged-coverage floor, manifest, configure hook, CHANGELOG, doc page,
version) before a satellite may carry the `release candidate` label.

Each satellite has in fact cleared that engineering bar already: an own coverage
gate (`.c8rc.json`) with unit tests over its security-critical core, a declared
per-satellite **merged** (unit + integration) coverage floor enforced in CI
(`scripts/check-satellite-coverage.mjs`), so a controller-heavy satellite whose
handlers are exercised by the integration tier is still held to a real number; an
auto-describable `lasagnaSatellite` manifest at the frozen Satellite ABI
(`satelliteApi: 1`), green `publint` + `arethetypeswrong`, a doc page, and a
CHANGELOG. What they have not cleared is the part no test can supply: none has
ever been installed by anyone. Until a satellite has real usage behind it, a
green pipeline is evidence, not a promise, so it stays `experimental` at `0.1.0`.

**What graduates an in-core opt-in feature to `release candidate`?** The same
bar, scoped to a feature rather than a package: its own coverage at the
graduation floor, a doc page, a stable public surface, and a CHANGELOG entry. The
opt-in features listed above (quotas, webhooks, metrics, audit logs, branding,
feature flags, impersonation) stay `experimental` until they clear it.

## How to read this if you are adopting

- Want true tenant isolation and nothing else? You are on `release-candidate`
  ground: the core, at `0.3.0`. Pin the version, follow the
  [deployment](/guides/deployment) and [security](/guides/security) guides, and you
  are leaning only on what is tested and gated in CI.
- Reaching for a satellite *package* (billing, SSO, backup, reporting, AI)? Those
  are `experimental` at `0.1.0`. Each cleared the graduation gate above (frozen
  Satellite ABI, its own merged coverage floor, doc page, and CHANGELOG), but none
  has production mileage. Pin the exact version, and expect a breaking change in a
  minor.
- Using an in-core opt-in feature (quotas, webhooks, metrics, audit logs,
  branding, feature flags, impersonation)? Those are still `experimental`: they
  work and are covered by tests, but they are not under the 1.x semver promise,
  so pin the version and read the changelog before each upgrade.
- Watch this page. As the security review and production mileage close, the core
  reaches `1.0.0` and `stable`, and the matrix is updated in the same change.

## Read next

- [Roadmap](/reference/roadmap); what unblocks `stable` and what is next.
- [Known limitations](/reference/known-limitations); the intentional non-goals.
- [Upgrade to 0.3](/reference/upgrade-to-0.3); the mechanical migration from 0.2.x.

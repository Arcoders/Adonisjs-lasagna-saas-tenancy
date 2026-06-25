---
title: Roadmap
description: Where the package stands today, what has to land before the isolation core is labelled stable, and what is under consideration next.
---

# Roadmap

This page is the single, honest view of where Lasagna is and where it is going.
For the formal label definitions and the per-feature matrix, see
[Stability](/reference/stability); for the things that are intentionally out of
scope, see [Known limitations](/reference/known-limitations).

## Where it stands today (1.0)

- The **isolation core** (drivers, routing, context, lifecycle) is a **release
  candidate**: feature-complete and green in CI against real Postgres and
  Redis, hardened against the failure modes documented in
  [Security](/guides/security).
- The **satellites** (billing, SSO, admin, backup, and the in-core opt-in
  features like quotas, webhooks, metrics) are **experimental**: usable and
  tested, but their surface may shift within a minor release.
- **Packaged satellites are a public extension point.** Third parties can ship
  their own satellite package (provider, migrations, configure hook) and have it
  discovered and installed by `configure`, without a PR to core. See
  [Creating a satellite](/guides/cookbook/creating-a-satellite). The official
  billing and SSO packages now own their own migrations through this same
  mechanism.

## What unblocks `stable`

The core is not labelled `stable` yet on purpose. Two things gate it, and
neither can be manufactured by a release:

1. **An independent security review.** The current hardening is the
   maintainer's own internal audit, not an external one.
2. **Production mileage.** Real deployments running real tenant traffic over
   time, surfacing the issues that only scale and uptime reveal.

When both land, the core moves to `stable` **inside the 1.x line, without a
major bump**.

## Under consideration

These are directions, not commitments, and not ordered by priority:

- Promoting individual satellites from experimental toward stable as they earn
  mileage.
- A driver-migration path (moving an existing tenant between isolation drivers).
- Richer feature-flag targeting beyond boolean + free-form config.
- First-class starter-kit / scaffolding for a new multi-tenant app.
- MySQL/MariaDB support as an opt-in satellite driver, built on the
  `IsolationDriver` extension point. It would be database-per-tenant only, with
  no schema-per-tenant or native Row-Level-Security equivalent, so it ships with
  explicit caveats. This is deliberately secondary to keeping the PostgreSQL core
  stable, conditioned on real MySQL-only demand, and would land additively in a
  future 1.x minor without a major bump.

If one of these blocks your adoption, open an issue describing the use case;
real demand reorders this list.

## How we version

Lasagna follows semver within the 1.x line. Breaking changes to a `stable`
surface require a major release; experimental surfaces may change in a minor
with a changelog note. Pin your version and read the
[release notes](/reference/release-notes) before upgrading.

## Read next

- [Stability](/reference/stability); label definitions and the feature matrix.
- [Known limitations](/reference/known-limitations); what is intentionally not here.
- [Upgrade to 1.0](/reference/upgrade-to-1.0); the mechanical changes from 0.x.

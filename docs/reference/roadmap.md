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
- The **satellite packages** (billing, SSO, admin, backup, websockets,
  reporting) are **release candidates**: each cleared the graduation gate (frozen
  Satellite ABI, its own merged coverage floor, doc page, CHANGELOG).
- The **in-core opt-in features** (quotas, webhooks, metrics, audit logs,
  branding, feature flags, impersonation) are **experimental**: usable and
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

- Promoting individual satellite packages from release candidate toward stable,
  and in-core opt-in features from experimental toward release candidate, as they
  earn mileage.
- A driver-migration path (moving an existing tenant between isolation drivers).
- Richer feature-flag targeting beyond boolean + free-form config.
- First-class starter-kit / scaffolding for a new multi-tenant app.

If one of these blocks your adoption, open an issue describing the use case;
real demand reorders this list.

## Not planned (by design)

These are deliberate non-goals. They come from focus and long-term
maintainability, not from technical limitations.

- Other databases (MySQL, MariaDB, and so on). Schema-per-tenant, Row-Level
  Security, and `search_path` isolation are Postgres-native and central to how
  Lasagna works. Supporting another database would mean compromising the parts
  we consider essential, so we focus on doing one thing well. If you need MySQL,
  see [Comparison](/reference/comparison) for packages that support it.
- Adapters for Express, NestJS, Fastify, or any non-AdonisJS framework. Lasagna
  is built only for AdonisJS 7. Going framework-neutral would mean giving up the
  deep AdonisJS integration that defines it, so we put that effort into the best
  possible experience for AdonisJS developers instead.

## How we version

Lasagna follows semver within the 1.x line. Breaking changes to a `stable`
surface require a major release; experimental surfaces may change in a minor
with a changelog note. Pin your version and read the
[release notes](/reference/release-notes) before upgrading.

## Read next

- [Stability](/reference/stability); label definitions and the feature matrix.
- [Known limitations](/reference/known-limitations); what is intentionally not here.
- [Upgrade to 1.0](/reference/upgrade-to-1.0); the mechanical changes from 0.x.

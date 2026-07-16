---
title: Comparison
description: Feature-by-feature comparison of @adonisjs-lasagna/saas-tenancy against stancl/tenancy, with a NestJS column for Node-ecosystem context. Filterable, searchable, honest about the gaps.
---

# How Lasagna compares

<Callout type="tip" title="The honest version">
<a href="https://tenancyforlaravel.com/"><code>stancl/tenancy</code></a>
is the gold standard in the Laravel world; stable since 2019, with a
dedicated site, a book, a course, and a Discord. We owe a real debt
to that project: it set the bar for what a serious multi-tenancy
package should look like. Lasagna covers the same ground and adds the
operational surface stancl leaves to the user. It also has gaps
stancl has filled. <code>stancl/tenancy</code> is the headline peer,
and the <strong>NestJS</strong> column sits beside it for
Node-ecosystem context: NestJS ships no first-party tenancy, so that
column reflects the most-used community package and the common
do-it-yourself patterns. This page tells you all of it.
</Callout>

The same data we use internally to track our position. Filter by
category, by who wins against stancl, or search a feature. The win
and parity counts compare Lasagna with stancl; the NestJS column is
context, not scored.

<ComparisonTable />

## Read this if you're choosing today

| If your team needs… | Pick |
|---|---|
| MySQL or MariaDB | `stancl/tenancy` |
| A Nova-equivalent admin UI today | `stancl/tenancy` |
| A boilerplate SaaS template you can clone | `stancl/tenancy` (Laravel) |
| A NestJS app wanting Mongo-style per-tenant databases | `nestjs-tenancy` |
| AdonisJS 7 + PostgreSQL with maximum operational surface | Lasagna |
| Schema-per-tenant + read replicas + circuit breaker out of the box | Lasagna |
| The doctor command and CI-friendly health gates | Lasagna |
| A built-in REST admin API + OpenAPI 3.1 spec | Lasagna |
| Per-tenant impersonation with HMAC + audit | Lasagna |

MySQL/MariaDB is the row where stancl wins on availability today. Lasagna is
PostgreSQL-only by design; if you need MySQL now, stancl is the right call.

If your stack is AdonisJS and Postgres, Lasagna ships more
production plumbing in one box than any other package on the
ecosystem today. If your stack is Laravel and you want the maturity
of a 6-year-old project with a course, a book, and a Discord:
`stancl/tenancy`.

## What we're filling next

Phase 4 of our roadmap is explicitly aimed at the gaps stancl has
filled: a public Discord, the
`@adonisjs-lasagna/dashboard` package (Inertia + Vue admin UI
consuming the OpenAPI spec), `create-lasagna-saas` (a starter kit
that wires Lasagna + Auth + Stripe), and the 1.0 release.

Track the work in the
[GitHub repo](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy).
Issues are open for feature requests.

## Read next

- [Why Lasagna](/start/why); the narrative behind the table.
- [Stability](/reference/stability); what is release candidate versus experimental.
- [Roadmap](/reference/roadmap); the gaps being filled next.

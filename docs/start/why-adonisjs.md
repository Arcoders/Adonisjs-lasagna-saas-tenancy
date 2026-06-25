---
title: Why AdonisJS?
description: How Lasagna embraces and builds on the AdonisJS design philosophy, so it feels like a native extension of the framework rather than an add-on.
---

# Why AdonisJS?

Lasagna does not just run on AdonisJS. It embraces the framework's philosophy and extends it into the multi-tenancy domain, so it feels like a native part of AdonisJS rather than a bolt-on. This page walks the pillars of AdonisJS and shows how Lasagna lines up with each one.

<Callout type="tip" title="One sentence">
If you know AdonisJS, you already know how to use Lasagna: the same providers, middleware, ace commands, container, and config conventions, applied to multi-tenancy.
</Callout>

## Batteries included

AdonisJS ships a complete, integrated toolkit (routing, ORM, validation, auth, queues, and more) so teams focus on application logic instead of wiring.

Lasagna applies the same principle to multi-tenancy. It is not a library that only solves isolation; it ships a full ecosystem from day one:

- **Real data isolation.** Each tenant lives in its own PostgreSQL schema by default, with a choice of isolation drivers (`schema-pg`, `database-pg`, and `rowscope-pg`).
- **Operational tooling.** A `doctor` command that diagnoses and repairs, more than 45 ace commands, a REST admin API, and a Helm chart for Kubernetes deployment.
- **SaaS-ready services.** Circuit breakers, read replicas, audit logs, HMAC-signed webhooks, OpenTelemetry tracing, Prometheus metrics, and scheduled backups with retention.
- **Modular extensibility.** Capabilities like billing, SSO, and reporting ship as opt-in satellites: you don't need everything at once, but everything is available.

## Convention over configuration

AdonisJS leans on clear conventions to cut boilerplate and give developers a predictable structure.

Lasagna adopts those same conventions:

- **Base models.** Extend `TenantBaseModel`, `BackofficeBaseModel`, or `CentralBaseModel` and queries route to the right context automatically, with nothing to wire by hand.
- **IoC container.** It integrates with the AdonisJS container, so dependency injection and provider-based extension work exactly like any native component.
- **Ace commands.** It uses the AdonisJS command system to offer a consistent, familiar CLI.
- **Config shape.** It follows the AdonisJS config pattern, with a single `config/multitenancy.ts` that centralizes every option.

## MVC architecture and extensibility

AdonisJS is built on MVC with a clear separation of concerns, and is designed to be extended through providers and middleware.

Lasagna fits straight into that architecture:

- **Native middleware.** It provides middleware like `TenantGuardMiddleware` and `RateLimitMiddleware` that you register in `start/kernel.ts` the same way as any other AdonisJS middleware.
- **Providers.** Each satellite (billing, SSO, and the rest) is an AdonisJS provider registered in `adonisrc.ts`, extending the framework modularly and by its conventions.
- **Bootstrappers.** It scopes cache, sessions, drive, mail, and broadcasts to the tenant context automatically through `AsyncLocalStorage`; per-tenant queues are handled by `TenantQueueService`, all without touching your business logic.

## Practical over enterprise

AdonisJS avoids the heavy abstractions of enterprise frameworks in favor of a direct, pragmatic development model.

Lasagna keeps that spirit by offering a direct solution to a hard problem. It does not impose a heavyweight architecture; it gives you the tools and leaves you in control. The opt-in satellite split avoids the weight of features you did not ask for, and the integration is clean enough that it does not fight AdonisJS; it leans on its foundations.

## A unified ecosystem

AdonisJS keeps its core features under one quality standard, which removes dependency fragmentation.

Lasagna applies the same principle. It is not a pile of unrelated packages but a unified platform:

- **A core.** The isolation and operations engine.
- **Official satellites.** Billing, SSO, reporting, backups, websockets, and administration, all versioned and maintained together.
- **A shared `satellite-test-kit`.** A single integration-test harness for the whole ecosystem, which keeps quality and behavior consistent.

## What about the satellites?

At first glance the satellite model might look like a departure from "batteries included". It is actually a more mature expression of it: it not only includes the batteries, it lets you choose which ones to install.

- **Want everything?** Install every satellite and you have a complete solution.
- **Only need the essentials?** Install just the core for a lean, powerful base.
- **Want to extend it?** The `satellite-template` lets you build your own satellites on the same convention.

This is more aligned with the AdonisJS philosophy than a monolith that bundles everything. It offers the same cohesion and quality with the flexibility of a modular ecosystem, which makes it more practical and less heavy.

## In short

Lasagna does not merely use AdonisJS. It takes the framework's philosophy to its fullest within the multi-tenancy domain, and it is built only for AdonisJS 7, by design:

- **Batteries included** gives you a complete, SaaS-ready toolkit.
- **Convention over configuration** follows AdonisJS conventions for models, commands, and config.
- **MVC and extensibility** integrate through middleware, providers, and bootstrappers.
- **Practical over enterprise** offers a direct, modular solution without forced complexity.
- **A unified ecosystem** holds one quality standard across the satellite suite.

It was built because the AdonisJS ecosystem deserved a proper multi-tenancy foundation, and that foundation is built with the same care and respect for the framework's conventions that make it feel like a natural part of it. Feedback that makes it better is always welcome.

## Thanks

Lasagna wouldn't exist without AdonisJS.

A heartfelt thank you to **Harminder Virk** for creating and continuously improving such an incredible framework. The developer experience, the architecture, and the attention to detail found throughout AdonisJS have been a constant source of inspiration while building Lasagna.

We're equally grateful to the AdonisJS community. Whether through discussions, bug reports, feature requests, tutorials, open-source contributions, or simply sharing your experiences, you've helped shape the ecosystem that made this project possible.

Lasagna was never meant to reinvent what AdonisJS already does so well. The goal has always been to build on top of it, stay true to its philosophy, and contribute something useful back to the community.

We hope Lasagna helps developers build great SaaS products, and that it becomes a small but meaningful part of the AdonisJS ecosystem.

Thank you for being part of the journey.

## Read next

- [Why Lasagna](/start/why); the layered, opt-in thesis and how it compares to stancl/tenancy.
- [Concepts](/start/concepts); the four-layer model and how a request flows.
- [Data isolation](/guides/data-isolation/); the driver that decides where tenant data lives.
- [Comparison](/reference/comparison); the feature-by-feature table, with a NestJS column.
- [Commands](/reference/commands); the full ace command reference.

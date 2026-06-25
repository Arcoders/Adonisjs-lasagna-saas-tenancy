---
title: Powered by Lasagna
description: What runs on Lasagna today, a complete reference app you can run yourself, and how to get your app listed.
---

# Powered by Lasagna

Lasagna reached 1.0 recently, so this gallery is young and growing. Everything
on it is real: no logos we have not earned the right to show. Today that means
a complete reference application you can run in minutes, and the fact that
Lasagna already powers Unreallab's own production. If you have shipped on it,
the next card here could be yours.

[Skip to how to get listed](#be-one-of-the-first).

## Built and maintained by Unreallab

Lasagna was created by Unreallab, a startup, and it is currently the foundation
of two of our own production projects. We build on it every day, so it is
maintained because we depend on it, not as a side project we might walk away
from. We will keep maintaining it.

We made it public for a simple reason: we ran into the hard multi-tenancy
problems ourselves, from connection routing to the isolation guarantees to the
operational plumbing, and we would rather no other developer lose the time we
spent solving them. If it saves you that time, it has done its job.

Community collaboration is welcome too. Open an issue, send a pull request, or
tell us what your stack is missing; real use cases decide where this goes next.

Built with a lot of love by **Ismael Haytam Tanane** and **Ayoub Fellat**.

## Build it your way

Lasagna hands you a hardened isolation core and then gets out of your way.
The core (drivers, routing, context, lifecycle) is the part we keep stable
and keep fixing. Everything layered on top is a satellite, and satellites are
a public extension point, not a closed list we control.

That means you are not waiting on our roadmap. If your product needs a
capability we don't ship, you don't file a request and hope it gets
prioritized someday. You build it as a satellite: your own provider, your own
migrations, your own configure hook, discovered and installed by the same
`configure` command that wires the official ones. Keep it private to your
codebase, or publish it to npm and share it with the community.

This is the exact mechanism we use ourselves. Billing and SSO ship as their
own packages and register through core's public registries without core ever
importing them. There is no privileged internal API; what we build on, you
build on.

Our commitment is twofold: keep the multitenancy core robust and dependable,
and maintain a set of optional satellites we believe are useful and common
enough to belong in the box, like billing, SSO, audit logs, and webhooks. That
shared baseline is on us, and we keep it solid.

Everything beyond it is yours. You are not waiting on our roadmap to build what
your product needs; you shape the feature surface around your project, on your
own timeline.

[Creating a satellite →](/guides/cookbook/creating-a-satellite)

## Reference application

<LasagnaCard variant="feature" title="examples/api">

A complete AdonisJS 7 app that exercises the package's feature
surface end to end. Wired up with all five bootstrappers, the doctor
command, backups, replicas, and the full satellite suite. Comes with
an **e2e suite of 120+ tests** you can run with one command:

```bash
cd examples/api
npm install
npm run test:e2e   # brings up docker-compose.yml infra, runs the suite, tears down
```

The suite covers tenant provisioning end to end, schema isolation,
contextual logging across HTTP and queue, the doctor command,
backups with restore round-trip, quota enforcement, lifecycle
events, the admin REST API, mail context propagation, replica
routing strategies, and the webhook delivery state machine.

[View on GitHub →](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/examples/api)

</LasagnaCard>

## Be one of the first

The gallery is open and waiting for its first real-world cards. If you are
running Lasagna in production, we want to feature you, and we will help you get
there.

What the first adopters get:

- Hands-on help from the maintainers wiring Lasagna into your stack.
- A permanent spot on this page once you are live.
- We help you wire it; you keep all of the credit.

How to get listed:

1. Open an issue with the `showcase` label describing your stack: which
   isolation driver, which satellites, and the shape of your tenants.
2. We will help you over any rough edges, then add your card. Cards follow this
   minimal format:

```yaml
name: 'Acme Workspaces'
url: 'https://acme.example'
logo: '/showcase/acme.svg'         # 200 x 80 SVG, monochrome ideal
tagline: 'Operations workspace for distributed teams.'
testimonial: |
  Lasagna let us ship multi-tenancy on day one without writing
  a single line of routing or schema code.
  Author Name, Role
isolationDriver: 'schema-pg'
satellites: ['audit', 'webhooks', 'sso']
sinceVersion: '1.0.0'
```

<Callout type="note" title="What we look for">

The bar for the main gallery is real production traffic with real tenants.
Internal tools and side projects are welcome too; they just go in a separate
"Demos" group, so the production cards stay an honest signal.

</Callout>

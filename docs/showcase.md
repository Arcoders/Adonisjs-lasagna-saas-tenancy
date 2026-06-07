---
title: Powered by Lasagna
description: SaaS apps built with @adonisjs-lasagna/saas-tenancy.
---

# Powered by Lasagna

Real apps shipping on schema-isolated tenants, built end-to-end with
this package. If you've launched something with Lasagna and want to
appear here, [open a PR on the docs
repo](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy)
adding your card to this page.

## Reference application

<LasagnaCard variant="feature" title="examples/api">

A complete AdonisJS 7 app that exercises every feature in the
package. Wired up with all six bootstrappers, the doctor command,
backups, replicas, and the full satellite suite. Comes with a
**111-test e2e suite** you can run with one command:

```bash
cd examples/api
npm install
docker compose -f compose.test.yml up -d
npm run test:e2e
```

The suite covers tenant provisioning end to end, schema isolation,
contextual logging across HTTP and queue, the doctor command,
backups with restore round-trip, quota enforcement, lifecycle
events, the admin REST API, mail context propagation, replica
routing strategies, and the webhook delivery state machine.

[View on GitHub →](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/examples/api)

</LasagnaCard>

## Coming soon

We're collecting "Built with Lasagna" submissions for the 1.0 launch.
The first three early adopters get direct support, a logo on this
page, and a post-mortem write-up on the blog.

If you're interested:

- Open an issue with the `showcase` label describing your stack.
- Or join the Discord (link in the navbar once we launch §6.1) and
  drop a message in `#showcase`.
- We help wire it, you keep the credit.

<Callout type="note" title="What we look for">

The bar is "real production traffic + real tenants". Internal demos
and side projects are welcome too; they just go in a separate
"Demos" section to keep the trust signal honest for production
adopters.

</Callout>

## Want to be listed?

The submission template is intentionally minimal:

```yaml
name: 'Acme Workspaces'
url: 'https://acme.example'
logo: '/showcase/acme.svg'         # 200 × 80 SVG, monochrome ideal
tagline: 'Operations workspace for distributed teams.'
testimonial: |
  Lasagna let us ship multi-tenancy on day one without writing
  a single line of routing or schema code.
  — Author Name, Role
isolationDriver: 'schema-pg'
satellites: ['audit', 'webhooks', 'sso']
sinceVersion: '1.0.0'
```

Drop the YAML block into `docs/data/showcase.yml` (file will exist
once we have the second submission) and open a PR.

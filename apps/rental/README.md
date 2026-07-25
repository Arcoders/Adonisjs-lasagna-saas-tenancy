# Karimoto

A real car-rental SaaS built on `@adonisjs-lasagna/*`, exercising the whole
platform: two auth realms, schema-per-tenant isolation, the nine satellites
(admin, billing, ai, crypto, sso, backup, websockets, reporting) plus the core
feature set, a `telematics` plugin, and two Inertia + React consoles (the
platform operator and the rental company).

- **Operator** lives on the apex host `localhost:3333`.
- **Companies** live on a vanity host `<slug>.localhost:3333` (e.g.
  `acme.localhost:3333`), stored as the tenant's `custom_domain`.

## Runtime processes

A real deployment runs three processes. In dev:

- `npm run dev` — the HTTP server (Vite is auto-started, no `--hmr` needed).
- `npm run dev:worker` — the queue worker (`queue:work`). **Required** for
  tenant provisioning: company creation dispatches an `InstallTenant` job, and
  the schema only exists once the worker has run it.

Infrastructure (Postgres `pgvector/pgvector:pg16` + Redis + MailCatcher) comes
up with `npm run infra:up`. Ports are 55433 / 56380 / 1025+1080, distinct from
the core demo so both run side by side.

## Setup from a clean database

Provisioning is asynchronous, so setup is two passes with the worker running in
between. From `apps/rental`:

```bash
npm run infra:up                     # Postgres + Redis + MailCatcher

# 1. Control plane: operator account, central car catalog, and the two demo
#    companies (each dispatches InstallTenant).
npm run setup                        # backoffice:setup + central migrate + rental:seed

# 2. Materialise the schemas: start the worker (leave it running) so it drains
#    the InstallTenant jobs. The AI provider's after('provision') hook installs
#    pgvector into the `extensions` schema as each company is provisioned.
npm run dev:worker                   # in a second terminal; wait for the jobs to drain

# 3. Data plane: migrate each tenant schema, then fill it with demo data.
npm run setup:demo                   # tenant:vector:provision + migration:tenant:run + rental:seed:demo
```

`setup:demo` runs `tenant:vector:provision` first as a belt-and-suspenders step:
it is idempotent, and it guarantees the `vector` extension exists on a
pre-existing database (or one whose schemas were provisioned before the AI
provider's hook was in place) before the `ai_embeddings vector(N)` migration runs.

Then start the server:

```bash
npm run dev                          # http://localhost:3333
```

### Logins (dev only, refused in production)

| Realm | Host | Email | Password |
|---|---|---|---|
| Operator | `localhost:3333` | `operator@karimoto.test` | `operator-demo-password` |
| Company staff | `acme.localhost:3333` | `owner@karimoto.test` | `owner-demo-password` |
| Company staff | `sahara-cars.localhost:3333` | `owner@karimoto.test` | `owner-demo-password` |

## The two seed commands

- **`rental:seed`** (control plane) — the operator account, the shared central
  car catalog, and the demo company rows (dispatching provisioning). Idempotent.
- **`rental:seed:demo`** (data plane) — fills each already-migrated company with
  branches, a rate card, a fleet drawn from the catalog, renters with encrypted
  PII, bookings across the lifecycle (invoices + payments for completed ones),
  and a small RAG corpus of policy docs whose bodies are embedded into the tenant
  vector store. Idempotent; safe to re-run to top up missing rows. Sizing follows
  the company plan (`fleet`/`enterprise` get a full fleet, `starter` a smaller one
  that stays under its `vehiclesPerTenant` quota).

## The fleet assistant (RAG)

The assistant streams over SSE at `POST /ai/chat`. Retrieval is opt-in
(`retrieve: true`): it embeds the query and searches the tenant's `ai_embeddings`
store, which `rental:seed:demo` populates from the policy docs. Offline (no
`ANTHROPIC_API_KEY`) the chat and embeddings run on the in-process mocks, so
retrieval returns real matches but the ranking is a deterministic hash, not
semantic relevance. Set `ANTHROPIC_API_KEY` (and a real embedding backend) in
`.env` and the same path uses the real model with no code change — re-run
`rental:seed:demo` so the corpus is re-embedded into the real vector space.

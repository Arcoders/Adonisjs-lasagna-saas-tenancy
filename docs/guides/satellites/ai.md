---
title: AI satellite
description: A per-tenant, cost-metered, SSRF-pinned streaming spine with a pluggable provider contract (Claude, DeepSeek, Kimi) that composes the kernel isolation, metering, resilience and secrets rails instead of laying parallel track.
---

# AI

`@adonisjs-lasagna/ai` is the streaming gateway for Lasagna. It ships the piece an
AI feature actually needs to be safe in a multi-tenant SaaS: a streaming spine
that meters cost per chunk, aborts mid-stream on budget, timeout, tenant suspend
or client disconnect, and reaches every model provider through the kernel's
IP-pinned fetch so an AI-initiated request can never be turned into an SSRF. It
composes the existing rails (isolation, quotas, resilience, secrets) rather than
building a parallel stack.

This release ships the streaming spine, the provider abstraction and the HTTP
gateway: the `StreamExtensionService`, the `AIProviderContract` with a
per-tenant default-deny allow-list and a streaming-presence gate, three real
providers (Claude, DeepSeek, Kimi), and the fail-closed `POST /ai/chat` SSE
endpoint with a membership gate, idempotent replays and mid-stream suspension
handling. The vector store, conversation memory, retrieval filtering and the AI
audit table are later workstreams that build on this choke point.

## Install

```bash
npm install @adonisjs-lasagna/ai @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/ai
```

`@adonisjs-lasagna/saas-tenancy` (the core) and `@adonisjs/core` are required
peers. `node ace configure` registers the provider in `adonisrc.ts`. There is no
`migration:run` step in this release; the AI satellite publishes no migrations
yet.

## Configure

Declare an `ai` block in `config/multitenancy.ts`. It is validated eagerly at
boot (`assertAiConfig`), so a missing key or a bad shape fails at startup rather
than at the first stream.

```ts
import { defineAiConfig } from '@adonisjs-lasagna/ai'

// inside your multitenancy config:
ai: defineAiConfig({
  // Default-deny per tenant (G12): a provider is selectable only if listed here.
  allowedProviders: ['claude', 'deepseek'],
  defaultProvider: 'claude',

  claude: {
    apiKey: env.get('ANTHROPIC_API_KEY'),
    defaultModel: 'claude-opus-4-8',
    // apiVersion: '2023-06-01',      // pins the anthropic-version header
    // allowedModels: ['claude-opus-4-8', 'claude-haiku-4-5'],
  },
  deepseek: {
    apiKey: env.get('DEEPSEEK_API_KEY'),
    defaultModel: 'deepseek-chat',
    // baseUrl: 'https://api.deepseek.com', // BYOK / self-host override
  },

  heartbeatMs: 15000, // must stay below any upstream proxy idle timeout
}),
```

Every value has a named-constant default and a config override, so nothing is
hardcoded at a call site. Keys are read from the environment; they are never
logged and never placed in a prompt, an error, a metric or a span. A missing key
for an allow-listed provider fails config validation at boot.

### Budget the aiTokens quota

The gateway reserves every stream's worst case against the `aiTokens` quota
before the provider is called (the fail-closed reserve rail), and settles the
actual per chunk. Budgets live where every other quota does:

```ts
// config/multitenancy.ts
plans: {
  defaultPlan: 'free',
  definitions: {
    free: { limits: { aiTokens: 50_000 } }, // per-tenant daily cap
    pro: { limits: { aiTokens: 5_000_000 } },
  },
  // Fleet-wide cap across ALL tenants, checked in the same atomic reserve: the
  // denial-of-wallet backstop for a shared managed provider account (G13).
  operatorCeiling: { aiTokens: 20_000_000 },
},
```

With NEITHER a per-plan `limits.aiTokens` nor `plans.operatorCeiling.aiTokens`
configured, the kernel treats the quota as an unlimited plan: the reservation is
an inert handle, no Redis is touched, and the endpoint runs unmetered. That is
convenient in development and a denial-of-wallet exposure in production, so the
`ai_budget` doctor check reports the posture and the provider logs a boot
warning. Set `config.ai.acknowledgeUnbudgetedAiTokens: true` to accept the risk
explicitly (the check keeps reporting it). A host that budgets `aiTokens` through
a dynamic `plans.getPlan` is invisible to the static boot read, so the boot side
never refuses to mount; the doctor check is the run-time-aware view.

### Rate-limit the provider keys

`config.ai.rateLimit` caps requests-per-window per tenant and per provider key,
a different rail from the token budget: the reserve caps token spend, this caps
request rate, and together they close the BYOK / denial-of-wallet vector.

```ts
ai: defineAiConfig({
  // ...
  rateLimit: { limit: 60, windowSeconds: 60 }, // 60 requests/min per tenant-key
}),
```

Each streamed request consumes one hit against
`ext:ai:<op>:<tenant>:<keyFingerprint>`, where the fingerprint is a one-way hash
of the active provider key (never the key). Over the window is a fail-closed 429;
a limiter-backend outage is a fail-closed 503, never a silent pass. A replay
served from the idempotency cache does not consume it. Absent, the token reserve
is the only cost cap. The trip rides the `IsthmusGuardTripped` channel as
`guard.ai_rate_limited`.

### The allow-list and BYOK

`allowedProviders` is a per-tenant default-deny list. Registering a new provider
never auto-enables it for a tenant; the tenant must be allow-listed onto it. A
provider block may set a `baseUrl` for a BYOK or self-hosted endpoint; that URL
is validated against the SSRF guard at boot and, decisively, on every call (the
per-call IP pin is the real boundary, not the boot-time check). The AI provider
surface forbids the fetch escape hatches (`trustedHost`, `allowLoopback`) so a
"local residency" configuration can never bypass the pin.

## Mount the routes

Mount the gateway from `start/routes.ts`, passing your middleware chain with
TenantGuard first (so the tenant is resolved and lifecycle-checked) and your
auth middleware after it (so the principal exists for authorization and
idempotency). The mount function lives on its own subpath because it touches
the router service; the main entry stays safe to import from config files.

```ts
// start/routes.ts
import { multitenancyAiRoutes } from '@adonisjs-lasagna/ai/routes'
import { middleware } from '#start/kernel'

multitenancyAiRoutes({
  middleware: [middleware.tenantGuard(), middleware.auth()],
  // prefix: '/ai',
})
```

<Callout type="warning" title="Fail-closed mount (G4)">
The routes refuse to mount without a middleware chain, without `config.ai`, or
without a membership gate. There is no public opt-out like the reporting
dashboard has: AI routes are tenant-scoped and cost-bearing, so an unguarded
mount is never legitimate. An empty middleware array counts as absent.
</Callout>

The single endpoint in this release is `POST {prefix}/chat`. It accepts a JSON
body (`messages`, optional `model`, `maxTokens`, `sessionId`) and answers with
an SSE stream of `token` frames followed by a terminal `done` frame naming the
outcome. `Last-Event-ID` is honoured as a resume cursor. There is no GET or
EventSource variant on purpose: EventSource cannot carry a body, so prompts
would ride the query string straight into access logs.

## Authorize access

`config.ai.authorizeAIAccess` is the AI membership gate, with the exact
contract of the kernel's `authorizeTenantAccess`: it receives the request
context and the resolved tenant, and returning `false` or throwing denies with
a 403. A throwing hook is treated as a denial rather than a 500, because an
erroring membership backend must fail closed. Unlike the kernel hook, which
only warns when unset, the AI mount requires this hook or an explicit
`acknowledgeNoMembershipGate: true`; the acknowledged posture logs a warning
at mount time and stays visible through the `ai_membership_gate` doctor check.

Tenant isolation is not user authorization: the gate scopes WHICH principals
may stream on a tenant's behalf. For WHICH documents a principal may retrieve,
see the `retrievalFilter` document ACL in [Retrieval (RAG)](#retrieval-rag).

## Idempotent replays

Send an `Idempotency-Key` header to make a chat retry-safe. A completed
response is cached per tenant, principal, session and key (an HMAC scope, so
no component ever appears in a cache key), and a retry inside
`idempotencyTtlMs` (default 60s) replays the same bytes, original event ids
included, with the `X-Ai-Idempotent-Replay: 1` header and zero provider cost.
The principal comes from `config.ai.resolvePrincipal` (default: the
`@adonisjs/auth` user id); a request with no resolvable principal gets no
idempotency at all, because a cached response must never be shareable across
unknown callers. Only completed streams are cached; aborted and failed calls
always retry fresh. Two genuinely concurrent identical requests both run and
both charge (the cache absorbs retries, it does not coordinate racers).

## Suspension mid-stream

A `TenantSuspended` or `TenantDeleted` event aborts that tenant's in-flight
streams immediately: the stream ends with a `done` frame carrying
`tenant_suspended`, and the tokens already streamed are still settled. The
abort is same-pod (the pod where the lifecycle change ran); on other pods the
next request is rejected by TenantGuard, the same posture as the kernel's
resolution-cache caveat.

## Guard events

Every fail-closed refusal in the satellite (the mount gate, the access gate,
the provider and model allow-lists, config validation, the idempotency header
bound, the per-key rate limit, the retrieval document ACL) emits the kernel's
public `IsthmusGuardTripped` event before it throws, with `guard.ai_*` ids
inside the documented taxonomy.
Subscribe once and both layers arrive on the same channel:

```ts
// start/events.ts
import { IsthmusGuardTripped } from '@adonisjs-lasagna/saas-tenancy/events'

emitter.on(IsthmusGuardTripped, ({ payload }) => {
  if (payload.id.startsWith('guard.ai_')) {
    alerting.notify(payload.severity, payload.event, payload.tenantId)
  }
})
```

AI trips are counted per tenant on the `ai_guard_rejections` metric; they do
not appear in the kernel's `multitenancy_isthmus_*` Prometheus counters, which
render kernel guards only. See the [Isthmus reference](/reference/isthmus) for
the taxonomy and budget semantics.

## Vector store (embeddings)

The AI satellite can also store per-tenant embeddings for retrieval (WS-AI-3).
An embedding can be inverted back to its source text, so a vector index is
sensitive tenant content, not a derived artifact. Isolation is structural
(invariant **I1**): the store never hardcodes a location. It asks the active
isolation driver `tableLocation(tenant)` where the tenant's embeddings physically
live and runs its SQL on that connection, so the same code is correct on
`schema-pg` and `database-pg`. Logical (`rowscope-pg`) isolation is the weakest
placement for inversion-sensitive data and is **refused** outright: embeddings
need a physically-isolated driver.

Opt in with an `embedding` block. It configures a single generic
OpenAI-compatible provider (point `baseUrl` at OpenAI, Voyage, Jina, or a
self-hosted `/embeddings` endpoint; nothing is vendor-hardcoded):

```ts
// inside your ai block:
embedding: {
  apiKey: env.get('AI_EMBEDDING_API_KEY'),
  baseUrl: 'https://api.openai.com/v1', // required: the /embeddings endpoint
  defaultModel: 'text-embedding-3-small',
  dimension: 1536,                       // baked into the vector(N) column; 1..2000
  // maxEmbeddingTokens: 512,            // per-chunk worst case reserved against aiTokens
  // authorizeIngestion: (ctx, tenant) => userMayWrite(ctx),  // the write gate (below)
},
```

The `dimension` is fixed at deploy time: it is written into the `vector(N)`
column by the per-tenant migration, and every row stores its `model` and `dim`
so a model swap that changes dimension is caught, not silently mis-ranked.
Changing the dimension after data exists needs a new migration. The model is also
folded into the row's dedup identity, so re-ingesting the same content under a
different (same-dimension) model stores a fresh vector rather than being swallowed
as a duplicate, and retrieval under the new model finds it.

**Provision pgvector.** The embeddings column needs the PostgreSQL `vector`
extension where the tenant's data lives. Installing an extension is a privileged
step, kept off the app's request role (G14):

```bash
node ace tenant:vector:provision   # installs `vector` under the privileged connection
```

On `database-pg` (one database per tenant) a new tenant's database is provisioned
automatically before its migration runs, so you only run the command to backfill
existing tenants. On `schema-pg` / `rowscope-pg` the extension is shared, so
running it once is enough. The opt-in `pgvector_extension` doctor check reports
where the extension is missing (and that the app role is not a superuser).

**Ingest.** `POST /ai/embed` (mounted in the same fail-closed group as `/chat`)
takes pre-chunked text and stores it under a `source` (the document key, and the
unit of rollback):

```bash
curl -X POST https://app.example.com/ai/embed \
  -H 'content-type: application/json' \
  -d '{ "source": "handbook.md", "input": ["chunk one", "chunk two"] }'
```

The endpoint authorizes first (the membership gate, then an optional
`authorizeIngestion` write gate, so a denied caller spends nothing), reserves
`aiTokens` for the embed (a non-streaming call still costs money, so it is
metered like a completion), embeds, and stores idempotently: a re-ingest of the
same `(source, content, model)` is a no-op, never a double insert, so no
`Idempotency-Key` header is needed. A per-plan `embeddingCount` limit caps how
many rows a tenant may store (threat #18), enforced atomically before the write.
An optional `sourceUrl` is fetched through the kernel's IP-pinned `safeFetch`, so
a document URL can never reach an internal or metadata host (#11). That fetch is
streamed and aborted the moment it crosses `ingestionMaxBytes` (default 1 MiB, so
a huge public body cannot exhaust memory) and time-bounded by `ingestionTimeoutMs`
(default 10s, so a hung upstream cannot pin a worker).

## Retrieval (RAG)

Retrieval closes the read half of the vector store (WS-AI-5). Search is
tenant-scoped by construction (it inherits I1 from the store), and adds a
per-USER document ACL, because tenant isolation is not user authorization:
without a document ACL, every user of a tenant can retrieve that tenant's ENTIRE
corpus.

**The document ACL (`retrievalFilter`, G2).** Opt in with a `retrieval` block.
`retrievalFilter(ctx, tenant)` returns a `RetrievalScope` that narrows a search
to what THIS user may see. It is a discriminated union, so the intent is
explicit:

```ts
{ kind: 'all' }                                // the whole tenant corpus
{ kind: 'sources', sources: ['handbook.md'] }  // an allow-list by provenance source ([] = sees nothing)
{ kind: 'metadata', match: { team: 'eng' } }   // a jsonb containment match
```

```ts
// inside your ai block:
retrieval: {
  retrievalFilter: (ctx, tenant) => ({ kind: 'sources', sources: sourcesFor(ctx.auth.user) }),
  // defaultLimit: 8, maxLimit: 50, maxQueryChars: 4000,
  // maxContextItems: 8, maxContextChars: 8000,   // bounds for RAG-into-chat (below)
},
```

The scope only NARROWS: the mandatory `(model, dim)` scope and the tenant
placement always apply, and every scope value is a bound parameter, never
interpolated SQL. The hook is fail-closed: a throw or an invalid return is a 403
`retrieval_denied` (with a `guard.ai_retrieval_denied` trip), never a silent
fallback to the whole corpus. When the hook is ABSENT, retrieval spans the whole
tenant corpus, an honest limit surfaced by the `ai_retrieval_gate` doctor check
and a boot warning; `acknowledgeUnscopedRetrieval: true` accepts that posture.

**Search route.** `POST /ai/retrieve` (in the same fail-closed group as `/chat`)
embeds the query, applies the document ACL, and returns the matches as JSON:

```bash
curl -X POST https://app.example.com/ai/retrieve \
  -H 'content-type: application/json' \
  -d '{ "query": "what is our refund policy?", "limit": 5 }'
# -> { "matches": [ { "id", "content", "metadata", "distance" }, ... ] }
```

It authorizes first, resolves the document ACL, then reserves `aiTokens` for the
query embed (a retrieval read still costs an embedding call, so it is metered
like a completion), embeds with the SAME provider the corpus used, and searches
under the scope. A parallel non-PII `AiRetrievalAuditEvent` (a `matchCount`,
never the query or a document) attributes the op.

**RAG into chat.** Add a `retrieve` field to a `/ai/chat` body to fold matches
into the prompt in one call:

```json
{ "messages": [ "..." ], "retrieve": { "query": "refund policy" } }
```

On a cache miss (a replay never re-retrieves), the gateway retrieves, then folds
the matches into the messages as a role-separated, fenced `user` turn right
before the question. Retrieved content is untrusted **data, not instructions**
(#10): it is never placed in a system turn, and the fence token is neutralized
inside each document so a hostile doc cannot forge a closing tag and "break out".
The block is bounded by `maxContextItems` / `maxContextChars` and trimmed so the
ASSEMBLED prompt never exceeds `maxPromptChars` (#8). Asking to retrieve without
an `embedding` block configured is a 400. `buildRetrievalContext` is exported for
hosts that assemble the context themselves.

Two structural guards pin the context-integrity invariants: `check-ai-invariant-4`
(the satellite never authors a system-role message, so retrieved or tenant data
can never become a trusted instruction, I4) and `check-ai-invariant-8` (every
streaming response path applies an output bound, I8).

## Use the streaming service directly

The gateway is the supported path, but the streaming service remains usable on
its own. `StreamExtensionService.stream(target, produce, options)` pumps an
async iterable of provider fragments to the client over SSE, settling cost per
chunk against a reservation and resolving a `StreamResult` that tells the
caller what happened (`completed`, `aborted` with a reason, or
`failed_preflight` with an error and its HTTP status). The per-request
`maxTokens` cap becomes the reservation worst case: the provider must not
exceed it and settle is clamped to it, so no fragment sequence can over-spend.

## Add a custom provider

Implement `AIProviderContract` (declare `capabilities.streaming: true` and a
`contractVersion`), then register it on the `AIProviderRegistry`. The registry
checks the contract version and then an unconditional streaming-presence gate, so
a provider that does not declare streaming fail-closes at registration rather
than degrading a streaming call at runtime. A provider streams through the
kernel's pinned fetch, so a custom or self-hosted endpoint is still SSRF-checked
and IP-pinned like the built-ins.

## Read next

- [Production checklist](/reference/production-checklist) for the heartbeat and
  proxy idle-timeout note.
- [Stability matrix](/reference/stability) for what the release-candidate label
  promises.

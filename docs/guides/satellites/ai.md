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
may stream on a tenant's behalf. The `retrievalFilter` name is reserved for
the retrieval workstream, where per-user document scoping becomes enforceable.

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
bound) emits the kernel's public `IsthmusGuardTripped` event before it throws,
with `guard.ai_*` ids inside the documented taxonomy. Subscribe once and both
layers arrive on the same channel:

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

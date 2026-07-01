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

This release is the streaming spine and the provider abstraction, not the full
platform. It ships the `StreamExtensionService`, the `AIProviderContract` with a
per-tenant default-deny allow-list and a streaming-presence gate, and three real
providers (Claude, DeepSeek, Kimi). The HTTP `/ai/chat` gateway, retrieval and
authorization middleware, the vector store, conversation memory and the AI audit
table are later workstreams that build on this spine.

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

## Use the streaming service

The HTTP gateway is a later workstream, but the streaming service is usable now.
`StreamExtensionService.stream(ctx, produce, options)` pumps an async iterable of
provider fragments to the client over SSE, settling cost per chunk against a
reservation and resolving a `StreamResult` that tells the caller what happened
(`completed`, `aborted` with a reason, or `failed_preflight` with an error and
its HTTP status). The per-request `maxTokens` cap becomes the reservation worst
case: the provider must not exceed it and settle is clamped to it, so no fragment
sequence can over-spend.

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

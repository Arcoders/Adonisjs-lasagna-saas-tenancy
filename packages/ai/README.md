# @adonisjs-lasagna/ai

The AI streaming gateway for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
a per-tenant, cost-metered, SSRF-pinned streaming spine with a pluggable provider
contract. It composes the kernel rails (isolation, metering, resilience, secrets)
instead of laying parallel track, so AI features ship already isolated and
billable rather than as a leaky LLM wrapper.

[![Stability: release candidate](https://img.shields.io/badge/stability-release_candidate-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: release candidate.** The provider contract and the streaming
> service are considered final under the 1.x promise, with the honest caveat
> that a correction forced by the pending security review or production mileage
> may land in a 1.x minor with a loud changelog entry. Pin the version and read
> the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

This release ships the streaming spine and the provider abstraction: the
`StreamExtensionService` (backpressure, heartbeat, four-way composed abort,
per-chunk validate-then-settle), the `AIProviderContract` with a per-tenant
default-deny allow-list and a streaming-presence gate, and three real providers
(Claude, DeepSeek, Kimi) that stream through the kernel's IP-pinned fetch with no
vendor SDKs. The HTTP gateway, retrieval, vector store, memory and AI audit are
later workstreams.

## Install

```bash
npm i @adonisjs-lasagna/ai @adonisjs-lasagna/saas-tenancy
node ace configure @adonisjs-lasagna/ai
```

`@adonisjs-lasagna/saas-tenancy` (the core) is a required peer, along with
`@adonisjs/core` (already present in a typical Adonis app). `node ace configure`
registers the provider in `adonisrc.ts`. There is no `migration:run` step in this
release; the AI satellite publishes no migrations yet.

## Configure

```ts
// config/multitenancy.ts
import { defineAiConfig } from '@adonisjs-lasagna/ai'

export default defineConfig({
  // ...core config...
  ai: defineAiConfig({
    allowedProviders: ['claude'], // default-deny per tenant (G12)
    defaultProvider: 'claude',
    claude: {
      apiKey: env.get('ANTHROPIC_API_KEY'),
      defaultModel: 'claude-opus-4-8',
    },
  }),
})
```

The `ai` block is validated at boot (`assertAiConfig`), so a missing key or a bad
shape fails at startup rather than at the first stream. Every tunable (base URLs,
models, the Anthropic version header, heartbeat, timeout) has a named-constant
default and a config override; nothing is hardcoded at a call site.

## Documentation

See the [AI satellite guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/ai)
for the full configuration reference, programmatic use of the streaming service,
and the custom-provider recipe.

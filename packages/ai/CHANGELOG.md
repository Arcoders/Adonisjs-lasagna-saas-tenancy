# Changelog

All notable changes to `@adonisjs-lasagna/ai` are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.0]

**Introduced the AI satellite at release candidate**: the streaming spine and the
provider abstraction that a future AI gateway calls through.

Added:
- **`AiConfig` config block** (`defineAiConfig`), validated eagerly at boot
  (`assertAiConfig`). Allow-list the providers a tenant may use (default-deny,
  G12), pick a default, and fill in the per-provider block. Every streaming
  tunable (heartbeat, timeout, per-request token cap) and every provider knob
  (base URL, model, Anthropic version) has a named-constant default and a config
  override, so nothing is hardcoded at a call site.
- **Provider contract + registry** (`AIProviderContract`, `AI_CONTRACT_VERSION`)
  with an unconditional streaming-presence gate at registration and a per-tenant
  default-deny allow-list, mirroring the billing provider pattern.
- **`StreamExtensionService`**: the SSE streaming integrator over the kernel's
  `executeExtension` and quota reservation seams, with backpressure, a tunable
  heartbeat, a four-way composed abort (timeout, liveness, client disconnect,
  budget early-stop), and per-chunk validate-then-settle clamped under the
  reservation worst case.
- **Three real providers** (Claude, DeepSeek, Kimi) that stream through the
  kernel's SSRF-pinned fetch with no vendor SDKs, selectable per tenant.
- **Observability**: the streamed call is wrapped in an `ai.stream` span
  (tenant / provider / model attributes only, never content) and emits integer
  usage metrics (`ai_requests`, `ai_tokens_total`, `ai_errors`,
  `ai_stream_disconnects`). No prompt or response text ever reaches telemetry.

import type {
  AiConfig,
  AIAuditConfig,
  AIEmbeddingConfig,
  AIInjectionConfig,
  AIMemoryConfig,
  AIProviderConfig,
  AIProviderName,
  AIResilienceConfig,
  AIRetrievalConfig,
  AIToolHostDefinition,
  AIToolsConfig,
} from './define_config.js'
import {
  DEFAULT_AI_PROVIDER,
  MAX_AI_TOOL_ROUNDS,
  MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT,
  MAX_EMBEDDING_DIM,
  MAX_TOOL_ARGS_CHARS,
  MAX_TOOL_CALLS_PER_REQUEST,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_TIMEOUT_MS,
  MAX_TOOLS_PER_ROUND,
} from './constants.js'
import { emitAiGuardEvent } from './isthmus/ai_guard_audit.js'

/** The built-in providers that require a matching config block when allow-listed. */
const BUILTIN_PROVIDERS = ['claude', 'deepseek', 'kimi'] as const

/** Ceiling for the idempotency replay TTL (5 min): bounds the post-purge residual-PII window (WS-AI-9). */
const MAX_IDEMPOTENCY_TTL_MS = 300_000
/** Ceiling for a single purge batch's statement_timeout (10 min). */
const MAX_PURGE_STATEMENT_TIMEOUT_MS = 600_000

/**
 * The single reject choke for config validation: every branch routes through
 * here so the `guard.ai_config_invalid` emission cannot drift from the throw
 * (one emit point instead of one per message). Config-phase trips usually have
 * no wired emitter yet, so the dispatch lands in the counted no_emitter drop;
 * the loud boot abort is the operator-facing signal.
 */
function fail(message: string): never {
  emitAiGuardEvent('guard.ai_config_invalid', {
    metadata: { reason: message.slice(0, 64) },
  })
  throw new Error(message)
}

/**
 * Eager, pure validation of the `ai` config block so a bad shape fails at boot
 * (in `AiProvider.boot`) rather than at the first stream. `undefined` passes (the
 * block is optional); only a present-but-wrong shape throws. Kept off the public
 * barrel intent-wise but exported so the provider and its unit specs can call it.
 * Mirrors reporting's `assertReportingConfig`.
 */
export function assertAiConfig(config: AiConfig | undefined): void {
  if (config === undefined || config === null) return
  if (typeof config !== 'object') {
    fail('[ai] config.ai must be an object')
  }

  assertAllowedProviders(config.allowedProviders)
  const allowed = new Set<AIProviderName>(config.allowedProviders)

  const effectiveDefault = config.defaultProvider ?? DEFAULT_AI_PROVIDER
  if (!allowed.has(effectiveDefault)) {
    fail(
      `[ai] defaultProvider "${effectiveDefault}" is not in allowedProviders ` +
        `(${config.allowedProviders.join(', ')}); allow-list it or pick another default`
    )
  }

  for (const name of BUILTIN_PROVIDERS) {
    if (allowed.has(name)) {
      assertProviderBlock(name, config[name])
    }
  }

  assertPositiveInteger('heartbeatMs', config.heartbeatMs)
  assertPositiveInteger('timeoutMs', config.timeoutMs)
  assertPositiveInteger('maxTokens', config.maxTokens)
  // Cap the idempotency TTL (WS-AI-9 honest-limit #4): a completed response's raw
  // frames are PII and only become UNREACHABLE (not deleted) on a purge, self-reaped
  // at this TTL. Keeping it short bounds that post-purge residual window.
  assertBoundedInteger('idempotencyTtlMs', config.idempotencyTtlMs, MAX_IDEMPOTENCY_TTL_MS)
  assertPositiveInteger('maxPromptChars', config.maxPromptChars)
  // The per-batch purge statement timeout (E14): a positive integer, bounded so a
  // fat-finger cannot make a batch effectively unbounded; `SET LOCAL 0` (no timeout)
  // is rejected by the positive-integer floor.
  assertBoundedInteger(
    'purgeStatementTimeoutMs',
    config.purgeStatementTimeoutMs,
    MAX_PURGE_STATEMENT_TIMEOUT_MS
  )
  assertResidencyConfig(config.residency)

  if (config.authorizeAIAccess !== undefined && typeof config.authorizeAIAccess !== 'function') {
    fail('[ai] config.ai.authorizeAIAccess, when set, must be a function (ctx, tenant) => boolean')
  }
  if (
    config.acknowledgeNoMembershipGate !== undefined &&
    typeof config.acknowledgeNoMembershipGate !== 'boolean'
  ) {
    fail('[ai] config.ai.acknowledgeNoMembershipGate, when set, must be a boolean')
  }
  if (config.resolvePrincipal !== undefined && typeof config.resolvePrincipal !== 'function') {
    fail('[ai] config.ai.resolvePrincipal, when set, must be a function (ctx) => principal')
  }
  if (config.redactOutput !== undefined && typeof config.redactOutput !== 'function') {
    fail(
      '[ai] config.ai.redactOutput, when set, must be a function (ctx, tenant, chunk) => string | null'
    )
  }
  if (
    config.acknowledgeUnbudgetedAiTokens !== undefined &&
    typeof config.acknowledgeUnbudgetedAiTokens !== 'boolean'
  ) {
    fail('[ai] config.ai.acknowledgeUnbudgetedAiTokens, when set, must be a boolean')
  }
  if (
    config.acknowledgeUnscopedRetrieval !== undefined &&
    typeof config.acknowledgeUnscopedRetrieval !== 'boolean'
  ) {
    fail('[ai] config.ai.acknowledgeUnscopedRetrieval, when set, must be a boolean')
  }
  assertRateLimit(config.rateLimit)
  assertEmbeddingConfig(config.embedding)
  assertInjectionConfig(config.injection)
  assertRetrievalConfig(config.retrieval)
  assertMemoryConfig(config.memory)
  assertAuditConfig(config.audit)
  assertResilienceConfig(config.resilience)
  assertToolsConfig(config.tools)
}

/**
 * The tool / function-calling block (WS-AI-11), when present: the hooks are
 * functions, each static `registry` entry is a well-formed tool definition, and
 * every bound is a positive integer no larger than its hard ceiling. The loop and
 * executor also clamp these defensively at runtime, but validating here makes an
 * out-of-bounds or mistyped value a loud boot abort rather than a silent clamp on
 * the first stream. `registry` and `resolveTools` may coexist. The fail-closed
 * default-deny authorization posture (an absent `authorizeTool`) is a runtime
 * concern the `ai_tools` doctor check surfaces, not a config error.
 */
function assertToolsConfig(tools: AIToolsConfig | undefined): void {
  if (tools === undefined) return
  if (typeof tools !== 'object' || tools === null) {
    fail('[ai] config.ai.tools, when set, must be an object')
  }

  if (tools.resolveTools !== undefined && typeof tools.resolveTools !== 'function') {
    fail('[ai] config.ai.tools.resolveTools, when set, must be a function (ctx, tenant)')
  }
  if (tools.authorizeTool !== undefined && typeof tools.authorizeTool !== 'function') {
    fail('[ai] config.ai.tools.authorizeTool, when set, must be a function (ctx, tenant, toolName)')
  }
  if (
    tools.acknowledgeUnauthorizedTools !== undefined &&
    typeof tools.acknowledgeUnauthorizedTools !== 'boolean'
  ) {
    fail('[ai] config.ai.tools.acknowledgeUnauthorizedTools, when set, must be a boolean')
  }
  if (tools.surfaceToolArgs !== undefined && typeof tools.surfaceToolArgs !== 'boolean') {
    fail('[ai] config.ai.tools.surfaceToolArgs, when set, must be a boolean')
  }
  if (tools.actionTools !== undefined) {
    if (typeof tools.actionTools !== 'object' || tools.actionTools === null) {
      fail('[ai] config.ai.tools.actionTools, when set, must be an object { enabled? }')
    }
    if (tools.actionTools.enabled !== undefined && typeof tools.actionTools.enabled !== 'boolean') {
      fail('[ai] config.ai.tools.actionTools.enabled, when set, must be a boolean')
    }
  }
  if (tools.registry !== undefined) {
    if (!Array.isArray(tools.registry)) {
      fail('[ai] config.ai.tools.registry, when set, must be an array of tool definitions')
    }
    tools.registry.forEach(assertToolDefinition)
  }

  assertBoundedInteger('tools.maxRounds', tools.maxRounds, MAX_AI_TOOL_ROUNDS)
  assertBoundedInteger('tools.maxToolsPerRound', tools.maxToolsPerRound, MAX_TOOLS_PER_ROUND)
  assertBoundedInteger(
    'tools.maxToolCallsPerRequest',
    tools.maxToolCallsPerRequest,
    MAX_TOOL_CALLS_PER_REQUEST
  )
  assertBoundedInteger('tools.toolTimeoutMs', tools.toolTimeoutMs, MAX_TOOL_TIMEOUT_MS)
  assertBoundedInteger('tools.maxToolResultChars', tools.maxToolResultChars, MAX_TOOL_RESULT_CHARS)
  assertBoundedInteger('tools.maxToolArgsChars', tools.maxToolArgsChars, MAX_TOOL_ARGS_CHARS)
  assertBoundedInteger(
    'tools.maxConcurrentPerTenant',
    tools.maxConcurrentPerTenant,
    MAX_CONCURRENT_TOOL_LOOPS_PER_TENANT
  )
}

/**
 * A static `registry` tool definition: a non-empty `name`, a non-empty
 * `description`, an object `inputSchema` (the JSON Schema shipped to the model), a
 * `handler` function, and — when set — a `mode` of `'read'` or `'action'`, a
 * boolean `requiresConfirmation`, and a `parseInput` function. Dynamic
 * (`resolveTools`) tools are validated at request time by `resolveToolRegistry`,
 * which drops a malformed entry rather than aborting the boot.
 */
function assertToolDefinition(tool: unknown, index: number): void {
  if (typeof tool !== 'object' || tool === null) {
    fail(`[ai] config.ai.tools.registry[${index}] must be a tool definition object`)
  }
  const t = tool as Partial<AIToolHostDefinition>
  const at = `config.ai.tools.registry[${index}]`
  if (typeof t.name !== 'string' || t.name.length === 0) {
    fail(`[ai] ${at}.name must be a non-empty string`)
  }
  if (typeof t.description !== 'string' || t.description.length === 0) {
    fail(`[ai] ${at} (${t.name}).description must be a non-empty string`)
  }
  if (typeof t.inputSchema !== 'object' || t.inputSchema === null || Array.isArray(t.inputSchema)) {
    fail(`[ai] ${at} (${t.name}).inputSchema must be an object (a JSON Schema)`)
  }
  if (typeof t.handler !== 'function') {
    fail(`[ai] ${at} (${t.name}).handler must be a function (args, ctx) => Promise`)
  }
  if (t.mode !== undefined && t.mode !== 'read' && t.mode !== 'action') {
    fail(`[ai] ${at} (${t.name}).mode, when set, must be 'read' or 'action'`)
  }
  if (t.requiresConfirmation !== undefined && typeof t.requiresConfirmation !== 'boolean') {
    fail(`[ai] ${at} (${t.name}).requiresConfirmation, when set, must be a boolean`)
  }
  if (t.parseInput !== undefined && typeof t.parseInput !== 'function') {
    fail(`[ai] ${at} (${t.name}).parseInput, when set, must be a function (raw) => args`)
  }
}

/**
 * The conversation memory block (WS-AI-4, I2), when present: the bounds are
 * positive integers, with `maxTurns` at least 1 (a zero-turn memory would store
 * but never replay). Presence of the block enables memory; the require-a-principal
 * posture is a runtime concern reported by the `ai_memory` doctor check, not a
 * config error.
 */
function assertMemoryConfig(memory: AIMemoryConfig | undefined): void {
  if (memory === undefined) return
  if (typeof memory !== 'object' || memory === null) {
    fail('[ai] config.ai.memory, when set, must be an object')
  }
  assertPositiveInteger('memory.maxTurns', memory.maxTurns)
  assertPositiveInteger('memory.maxChars', memory.maxChars)
  assertPositiveInteger('memory.ttlMs', memory.ttlMs)
}

/**
 * The append-only audit block (WS-AI-7), when present: `enabled` is the only knob
 * and must be a boolean. Audit is on by default (attribution is fail-closed), so a
 * host only sets this to opt out with `{ enabled: false }`.
 */
function assertAuditConfig(audit: AIAuditConfig | undefined): void {
  if (audit === undefined) return
  if (typeof audit !== 'object' || audit === null) {
    fail('[ai] config.ai.audit, when set, must be an object')
  }
  if (audit.enabled !== undefined && typeof audit.enabled !== 'boolean') {
    fail('[ai] config.ai.audit.enabled, when set, must be a boolean')
  }
}

/**
 * The resilience block (Wave 1), when present: each of `memory` / `idempotency` /
 * `rateLimit` is an optional object whose only field is a `policy` that must be
 * `'fail-open'` or `'fail-closed'`. Absent fields default to today's semantics, so a
 * host only sets this to override a per-operation posture.
 */
function assertResilienceConfig(resilience: AIResilienceConfig | undefined): void {
  if (resilience === undefined) return
  if (typeof resilience !== 'object' || resilience === null) {
    fail('[ai] config.ai.resilience, when set, must be an object')
  }
  assertResiliencePolicyBlock('memory', resilience.memory)
  assertResiliencePolicyBlock('idempotency', resilience.idempotency)
  assertResiliencePolicyBlock('rateLimit', resilience.rateLimit)
}

/** One `config.ai.resilience.<op>` block: an object whose optional `policy` is a valid FailurePolicy. */
function assertResiliencePolicyBlock(name: string, block: { policy?: unknown } | undefined): void {
  if (block === undefined) return
  if (typeof block !== 'object' || block === null) {
    fail(`[ai] config.ai.resilience.${name}, when set, must be an object`)
  }
  if (
    block.policy !== undefined &&
    block.policy !== 'fail-open' &&
    block.policy !== 'fail-closed'
  ) {
    fail(`[ai] config.ai.resilience.${name}.policy, when set, must be 'fail-open' or 'fail-closed'`)
  }
}

/**
 * The injection block (Wave 3), when present: `classifier` must be a function (its
 * RETURN shape is a request-time gate, never inspected here, per discipline point
 * 4); `onError` must be `'open'` or `'closed'`; `scanRetrieved` must be a boolean.
 * Every branch routes through `fail()` (the single `guard.ai_config_invalid` choke).
 * The absent-classifier posture (structural boundary only) is the correct default,
 * surfaced by the `ai_injection` doctor check, not a config error.
 */
function assertInjectionConfig(injection: AIInjectionConfig | undefined): void {
  if (injection === undefined) return
  if (typeof injection !== 'object' || injection === null) {
    fail('[ai] config.ai.injection, when set, must be an object')
  }
  if (injection.classifier !== undefined && typeof injection.classifier !== 'function') {
    fail('[ai] config.ai.injection.classifier, when set, must be a function (ctx, tenant, input)')
  }
  if (
    injection.onError !== undefined &&
    injection.onError !== 'open' &&
    injection.onError !== 'closed'
  ) {
    fail("[ai] config.ai.injection.onError, when set, must be 'open' or 'closed'")
  }
  if (injection.scanRetrieved !== undefined && typeof injection.scanRetrieved !== 'boolean') {
    fail('[ai] config.ai.injection.scanRetrieved, when set, must be a boolean')
  }
}

/**
 * The retrieval / RAG block (WS-AI-5), when present: `retrievalFilter` is the
 * per-user document ACL hook (G2), so it must be a function; the bounds are
 * positive integers. The absent-hook posture (whole tenant corpus) is a
 * documented honest limit, surfaced by the `ai_retrieval_gate` doctor check, not
 * a config error.
 */
function assertRetrievalConfig(retrieval: AIRetrievalConfig | undefined): void {
  if (retrieval === undefined) return
  if (typeof retrieval !== 'object' || retrieval === null) {
    fail('[ai] config.ai.retrieval, when set, must be an object')
  }
  if (retrieval.retrievalFilter !== undefined && typeof retrieval.retrievalFilter !== 'function') {
    fail('[ai] config.ai.retrieval.retrievalFilter, when set, must be a function (ctx, tenant)')
  }
  assertPositiveInteger('retrieval.defaultLimit', retrieval.defaultLimit)
  assertPositiveInteger('retrieval.maxLimit', retrieval.maxLimit)
  assertPositiveInteger('retrieval.maxQueryChars', retrieval.maxQueryChars)
  assertPositiveInteger('retrieval.maxContextItems', retrieval.maxContextItems)
  assertPositiveInteger('retrieval.maxContextChars', retrieval.maxContextChars)
}

/**
 * The vector-store / embedding block (WS-AI-3), when present: a generic
 * OpenAI-compatible provider needs a key and a base URL (there is no default
 * public endpoint), the dimension is baked into the `vector(N)` column so it
 * must be a pgvector-indexable integer (1..2000), and the bounds are positive
 * integers.
 */
function assertEmbeddingConfig(embedding: AIEmbeddingConfig | undefined): void {
  if (embedding === undefined) return
  if (typeof embedding !== 'object' || embedding === null) {
    fail('[ai] config.ai.embedding, when set, must be an object')
  }
  if (typeof embedding.apiKey !== 'string' || embedding.apiKey.length === 0) {
    fail(
      '[ai] config.ai.embedding.apiKey must be a non-empty string (read it from the environment)'
    )
  }
  if (embedding.baseUrl === undefined) {
    fail(
      '[ai] config.ai.embedding.baseUrl is required (the OpenAI-compatible /embeddings endpoint)'
    )
  }
  assertHttpsUrl('config.ai.embedding.baseUrl', embedding.baseUrl)
  if (embedding.dimension !== undefined) {
    if (
      typeof embedding.dimension !== 'number' ||
      !Number.isInteger(embedding.dimension) ||
      embedding.dimension < 1 ||
      embedding.dimension > MAX_EMBEDDING_DIM
    ) {
      fail(
        `[ai] config.ai.embedding.dimension must be an integer in 1..${MAX_EMBEDDING_DIM} (pgvector index limit)`
      )
    }
  }
  assertPositiveInteger('embedding.maxEmbeddingTokens', embedding.maxEmbeddingTokens)
  assertPositiveInteger('embedding.maxChunkChars', embedding.maxChunkChars)
  assertPositiveInteger('embedding.maxBatchChunks', embedding.maxBatchChunks)
  assertPositiveInteger('embedding.maxMetadataBytes', embedding.maxMetadataBytes)
  assertPositiveInteger('embedding.ingestionMaxBytes', embedding.ingestionMaxBytes)
  assertPositiveInteger('embedding.ingestionTimeoutMs', embedding.ingestionTimeoutMs)
  if (
    embedding.defaultModel !== undefined &&
    (typeof embedding.defaultModel !== 'string' || embedding.defaultModel.length === 0)
  ) {
    fail('[ai] config.ai.embedding.defaultModel, when set, must be a non-empty string')
  }
  if (
    embedding.provider !== undefined &&
    (typeof embedding.provider !== 'string' || embedding.provider.length === 0)
  ) {
    fail('[ai] config.ai.embedding.provider, when set, must be a non-empty string')
  }
  if (embedding.allowedModels !== undefined) {
    if (
      !Array.isArray(embedding.allowedModels) ||
      embedding.allowedModels.some((m) => typeof m !== 'string')
    ) {
      fail('[ai] config.ai.embedding.allowedModels must be an array of strings')
    }
  }
  if (
    embedding.authorizeIngestion !== undefined &&
    typeof embedding.authorizeIngestion !== 'function'
  ) {
    fail('[ai] config.ai.embedding.authorizeIngestion, when set, must be a function (ctx, tenant)')
  }
}

/** The per-key rate-limit block, when present, needs positive-integer limit + window. */
function assertRateLimit(rateLimit: AiConfig['rateLimit']): void {
  if (rateLimit === undefined) return
  if (typeof rateLimit !== 'object' || rateLimit === null) {
    fail('[ai] config.ai.rateLimit, when set, must be an object { limit, windowSeconds }')
  }
  for (const field of ['limit', 'windowSeconds'] as const) {
    const value = rateLimit[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      fail(`[ai] config.ai.rateLimit.${field} must be a positive integer`)
    }
  }
}

/** The allow-list must be a non-empty array of non-empty strings. */
function assertAllowedProviders(allowedProviders: AiConfig['allowedProviders']): void {
  if (!Array.isArray(allowedProviders) || allowedProviders.length === 0) {
    fail('[ai] config.ai.allowedProviders must be a non-empty array (default-deny per tenant)')
  }
  for (const name of allowedProviders) {
    if (typeof name !== 'string' || name.length === 0) {
      fail('[ai] config.ai.allowedProviders entries must be non-empty strings')
    }
  }
}

/** A built-in provider that is allow-listed must carry a valid config block. */
function assertProviderBlock(name: string, block: AIProviderConfig | undefined): void {
  if (!block || typeof block !== 'object') {
    fail(`[ai] provider "${name}" is allow-listed but config.ai.${name} is missing`)
  }
  if (typeof block.apiKey !== 'string' || block.apiKey.length === 0) {
    fail(`[ai] config.ai.${name}.apiKey must be a non-empty string (read it from the environment)`)
  }
  if (
    block.defaultModel !== undefined &&
    (typeof block.defaultModel !== 'string' || block.defaultModel.length === 0)
  ) {
    fail(`[ai] config.ai.${name}.defaultModel, when set, must be a non-empty string`)
  }
  if (block.baseUrl !== undefined) {
    assertHttpsUrl(`config.ai.${name}.baseUrl`, block.baseUrl)
  }
  if (block.allowedModels !== undefined) {
    if (
      !Array.isArray(block.allowedModels) ||
      block.allowedModels.some((m) => typeof m !== 'string')
    ) {
      fail(`[ai] config.ai.${name}.allowedModels must be an array of strings`)
    }
  }
  if (block.apiVersion !== undefined && typeof block.apiVersion !== 'string') {
    fail(`[ai] config.ai.${name}.apiVersion must be a string`)
  }
}

/** A configured base URL must parse and be https (the SSRF guard rechecks the resolved IP at call time). */
function assertHttpsUrl(label: string, value: unknown): void {
  if (typeof value !== 'string') {
    fail(`[ai] ${label} must be a string`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    fail(`[ai] ${label} is not a valid URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'https:') {
    fail(`[ai] ${label} must be https (got ${url.protocol})`)
  }
}

/** A tunable numeric knob, when present, must be a positive finite integer. */
function assertPositiveInteger(label: string, value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    fail(`[ai] config.ai.${label} must be a positive integer`)
  }
}

/** A tunable numeric knob, when present, must be a positive integer no larger than `max`. */
function assertBoundedInteger(label: string, value: unknown, max: number): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > max) {
    fail(`[ai] config.ai.${label} must be a positive integer <= ${max}`)
  }
}

/**
 * The per-tenant residency hook (WS-AI-9, #7 / #15), when present, must be a
 * function. Its return shape (`{mode:'local-only'}` | `{allowedProviders}`) is
 * resolved and validated at request time, fail-closed, by the residency gate; a
 * malformed return there refuses remote egress rather than aborting the boot.
 */
function assertResidencyConfig(residency: AiConfig['residency']): void {
  if (residency === undefined) return
  if (typeof residency !== 'function') {
    fail('[ai] config.ai.residency, when set, must be a function (tenant) => residency posture')
  }
}

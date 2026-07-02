import type { AiConfig, AIProviderConfig, AIProviderName } from './define_config.js'
import { DEFAULT_AI_PROVIDER } from './constants.js'
import { emitAiGuardEvent } from './isthmus/ai_guard_audit.js'

/** The built-in providers that require a matching config block when allow-listed. */
const BUILTIN_PROVIDERS = ['claude', 'deepseek', 'kimi'] as const

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
  assertPositiveInteger('idempotencyTtlMs', config.idempotencyTtlMs)
  assertPositiveInteger('maxPromptChars', config.maxPromptChars)

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

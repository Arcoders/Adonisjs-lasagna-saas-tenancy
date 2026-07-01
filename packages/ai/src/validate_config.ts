import type { AiConfig, AIProviderConfig, AIProviderName } from './define_config.js'
import { DEFAULT_AI_PROVIDER } from './constants.js'

/** The built-in providers that require a matching config block when allow-listed. */
const BUILTIN_PROVIDERS = ['claude', 'deepseek', 'kimi'] as const

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
    throw new Error('[ai] config.ai must be an object')
  }

  assertAllowedProviders(config.allowedProviders)
  const allowed = new Set<AIProviderName>(config.allowedProviders)

  const effectiveDefault = config.defaultProvider ?? DEFAULT_AI_PROVIDER
  if (!allowed.has(effectiveDefault)) {
    throw new Error(
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
}

/** The allow-list must be a non-empty array of non-empty strings. */
function assertAllowedProviders(allowedProviders: AiConfig['allowedProviders']): void {
  if (!Array.isArray(allowedProviders) || allowedProviders.length === 0) {
    throw new Error(
      '[ai] config.ai.allowedProviders must be a non-empty array (default-deny per tenant)'
    )
  }
  for (const name of allowedProviders) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new Error('[ai] config.ai.allowedProviders entries must be non-empty strings')
    }
  }
}

/** A built-in provider that is allow-listed must carry a valid config block. */
function assertProviderBlock(name: string, block: AIProviderConfig | undefined): void {
  if (!block || typeof block !== 'object') {
    throw new Error(`[ai] provider "${name}" is allow-listed but config.ai.${name} is missing`)
  }
  if (typeof block.apiKey !== 'string' || block.apiKey.length === 0) {
    throw new Error(
      `[ai] config.ai.${name}.apiKey must be a non-empty string (read it from the environment)`
    )
  }
  if (
    block.defaultModel !== undefined &&
    (typeof block.defaultModel !== 'string' || block.defaultModel.length === 0)
  ) {
    throw new Error(`[ai] config.ai.${name}.defaultModel, when set, must be a non-empty string`)
  }
  if (block.baseUrl !== undefined) {
    assertHttpsUrl(`config.ai.${name}.baseUrl`, block.baseUrl)
  }
  if (block.allowedModels !== undefined) {
    if (
      !Array.isArray(block.allowedModels) ||
      block.allowedModels.some((m) => typeof m !== 'string')
    ) {
      throw new Error(`[ai] config.ai.${name}.allowedModels must be an array of strings`)
    }
  }
  if (block.apiVersion !== undefined && typeof block.apiVersion !== 'string') {
    throw new Error(`[ai] config.ai.${name}.apiVersion must be a string`)
  }
}

/** A configured base URL must parse and be https (the SSRF guard rechecks the resolved IP at call time). */
function assertHttpsUrl(label: string, value: unknown): void {
  if (typeof value !== 'string') {
    throw new Error(`[ai] ${label} must be a string`)
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`[ai] ${label} is not a valid URL: ${JSON.stringify(value)}`)
  }
  if (url.protocol !== 'https:') {
    throw new Error(`[ai] ${label} must be https (got ${url.protocol})`)
  }
}

/** A tunable numeric knob, when present, must be a positive finite integer. */
function assertPositiveInteger(label: string, value: unknown): void {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`[ai] config.ai.${label} must be a positive integer`)
  }
}

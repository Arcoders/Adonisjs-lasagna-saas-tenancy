import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AIProviderConfig, AiConfig } from '../define_config.js'
import { DEFAULT_AI_PROVIDER } from '../constants.js'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'

/** The provider (and optional model) resolved for a tenant. */
export interface TenantProviderSelection {
  readonly provider: string
  readonly model?: string | undefined
}

const BUILTIN_KEYS = ['claude', 'deepseek', 'kimi'] as const
type BuiltinKey = (typeof BUILTIN_KEYS)[number]

/**
 * Resolve which provider a tenant streams through, behind the per-tenant
 * default-deny allow-list (G12). This is the single seam a future WS-AI-2 swaps
 * for per-tenant BYOK / residency storage: it already takes the tenant model, so
 * reading a per-tenant override here is a non-breaking change to the body, not
 * the signature. Pure (no container, no boot) so it unit-tests without an app.
 */
export function resolveTenantProviderSelection(
  tenant: TenantModelContract,
  config: AiConfig | undefined
): TenantProviderSelection {
  if (!config) {
    throw new AIException(
      'config_missing',
      'the ai config block is absent; declare config.ai before streaming'
    )
  }

  // WS-AI-2 reads a per-tenant provider / model override keyed by the tenant
  // here; until then every tenant resolves the configured default.
  const provider = config.defaultProvider ?? DEFAULT_AI_PROVIDER

  // Default-deny: the resolved provider must be explicitly allow-listed.
  if (!config.allowedProviders.includes(provider)) {
    emitAiGuardEvent('guard.ai_provider_allowlist', {
      tenantId: tenant.id,
      metadata: { provider: String(provider).slice(0, 64) },
    })
    throw new AIException(
      'provider_not_allowed',
      `Refusing to stream: provider "${provider}" is not allow-listed for this tenant`
    )
  }

  const block: AIProviderConfig | undefined = BUILTIN_KEYS.includes(provider as BuiltinKey)
    ? config[provider as BuiltinKey]
    : undefined
  return { provider, model: block?.defaultModel }
}

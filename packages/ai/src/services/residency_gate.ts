import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import AIException from '../exceptions/ai_exception.js'
import type { AiConfig, AIProviderConfig, ResidencyPosture } from '../define_config.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * The data-residency / no-train gate (WS-AI-9, #7 / #15). The SINGLE emission
 * site for `guard.ai_residency_denied` (so `no_silent_ai_guard` is satisfied by
 * one file), enforced at request time BEFORE any cost at two egress points:
 *
 *  - chat provider selection (`enforceChatResidency`), after the global provider
 *    allow-list has already picked a provider;
 *  - the embedding egress (`enforceEmbeddingResidency`) used by `/ai/embed`,
 *    `/ai/retrieve`, and RAG-into-chat — the choke point the chat allow-list
 *    never sees (the embedding backend is configured separately, E7).
 *
 * The per-tenant posture is resolved FAIL-CLOSED (E8, mirroring the retrieval
 * ACL): a resolver that throws or returns a malformed shape refuses remote
 * egress rather than letting a resolver bug silently permit it. Residency checks
 * provider IDENTITY (name + whether the effective endpoint is loopback), NOT a
 * remote endpoint's geography — a documented honest limit (a BYOK `baseUrl` is
 * the host's to place).
 */

/** Refuse the request: emit the guard (with the tenant) once, then throw the 403. */
function denyResidency(tenant: TenantModelContract, reason: string): never {
  emitAiGuardEvent('guard.ai_residency_denied', {
    tenantId: tenant.id,
    metadata: { reason: reason.slice(0, 64) },
  })
  throw new AIException(
    'residency_denied',
    'Refusing the request: the tenant data-residency posture does not permit this egress.'
  )
}

/** Narrow an unknown resolver return to a valid {@link ResidencyPosture}; anything else is fail-closed. */
function isResidencyPosture(value: unknown): value is ResidencyPosture {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  if ('mode' in v) return v.mode === 'local-only'
  if ('allowedProviders' in v) {
    return (
      Array.isArray(v.allowedProviders) && v.allowedProviders.every((p) => typeof p === 'string')
    )
  }
  return false
}

/**
 * Resolve the tenant's posture, fail-closed. Absent resolver ⇒ undefined
 * (residency unconstrained). A throw or malformed return refuses remote egress.
 */
async function resolvePosture(
  tenant: TenantModelContract,
  ai: AiConfig | undefined
): Promise<ResidencyPosture | undefined> {
  const resolver = ai?.residency
  if (resolver === undefined) return undefined
  let result: unknown
  try {
    result = await resolver(tenant)
  } catch {
    denyResidency(tenant, 'resolver_error')
  }
  if (!isResidencyPosture(result)) {
    denyResidency(tenant, 'invalid_posture')
  }
  return result
}

/** True only for an explicit loopback endpoint; an absent baseUrl means the provider's default PUBLIC endpoint (remote). */
function isLoopbackEndpoint(baseUrl: string | undefined): boolean {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return false
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    return false
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || host === '127.0.0.1' || host.startsWith('127.')
}

/** The configured base URL for a built-in/BYOK provider block, or undefined (its default public endpoint). */
function providerBaseUrl(providerName: string, ai: AiConfig | undefined): string | undefined {
  const block = (ai as Record<string, AIProviderConfig | undefined> | undefined)?.[providerName]
  return block?.baseUrl
}

/**
 * Enforce residency for the chat LLM egress. `local-only` refuses a provider
 * whose effective endpoint is not loopback; an explicit `allowedProviders`
 * posture refuses a provider name outside the tenant's list.
 */
export async function enforceChatResidency(
  tenant: TenantModelContract,
  providerName: string,
  ai: AiConfig | undefined
): Promise<void> {
  const posture = await resolvePosture(tenant, ai)
  if (posture === undefined) return
  if ('mode' in posture) {
    if (!isLoopbackEndpoint(providerBaseUrl(providerName, ai))) {
      denyResidency(tenant, 'local_only_remote_provider')
    }
    return
  }
  if (!posture.allowedProviders.includes(providerName)) {
    denyResidency(tenant, 'provider_not_in_residency')
  }
}

/**
 * Enforce residency for the embedding egress (ingest / retrieve / RAG query
 * embed). `local-only` refuses a non-loopback embedding backend (so a
 * data-sovereign tenant never ships documents or a query to a remote embedder).
 * An `allowedProviders` posture does NOT narrow embeddings: the embedding
 * backend is deploy-global in 1.0 (honest limit #2), so only the `local-only`
 * posture constrains it.
 */
export async function enforceEmbeddingResidency(
  tenant: TenantModelContract,
  ai: AiConfig | undefined
): Promise<void> {
  const posture = await resolvePosture(tenant, ai)
  if (posture === undefined) return
  if ('mode' in posture) {
    if (!isLoopbackEndpoint(ai?.embedding?.baseUrl)) {
      denyResidency(tenant, 'local_only_remote_embedding')
    }
  }
}

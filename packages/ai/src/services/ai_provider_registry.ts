import { assertContractCompat } from '@adonisjs-lasagna/saas-tenancy/sdk'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AIProviderContract } from '../types/ai_provider_contract.js'
import type { AiConfig } from '../define_config.js'
import { AI_CONTRACT_VERSION } from '../sdk/contract_version.js'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import { resolveTenantProviderSelection } from './tenant_provider_selection.js'

/**
 * Holds the registered AI providers plus the active default. `AiProvider` seeds
 * the built-ins from `config.ai`; tests and hosts register their own via
 * {@link AIProviderRegistry.register}.
 *
 * Stateful (Map-backed), so it must be resolved via `container.make(...)`, never
 * `new`-ed ad hoc. Mirrors `BillingDriverRegistry`, with two additions: an
 * unconditional streaming-presence gate at registration, and a per-tenant
 * `forTenant` selection behind the default-deny allow-list.
 */
export default class AIProviderRegistry {
  readonly #providers = new Map<string, AIProviderContract>()
  #activeName: string | undefined

  register(provider: AIProviderContract, opts: { activate?: boolean } = {}): this {
    // Reject a provider built against an incompatible contract version (newer
    // than this build throws; older or absent warns). Version-only, like billing.
    assertContractCompat(
      provider.contractVersion,
      AI_CONTRACT_VERSION,
      `ai provider "${provider.name}"`
    )

    // The one divergence from billing: an unconditional streaming-presence gate.
    // A provider that does not declare streaming fail-closes at registration, so
    // it can never degrade a streaming call at runtime, regardless of version.
    if (provider.capabilities?.streaming !== true) {
      emitAiGuardEvent('guard.ai_streaming_capability', {
        metadata: { provider: String(provider.name).slice(0, 64) },
      })
      throw new Error(
        `ai provider "${provider.name}" does not declare capabilities.streaming; ` +
          `a non-streaming provider cannot serve the streaming gateway`
      )
    }

    this.assertShape(provider)

    this.#providers.set(provider.name, provider)
    if (opts.activate || !this.#activeName) {
      this.#activeName = provider.name
    }
    return this
  }

  /**
   * The EXT-3 shape gate backing the v2 contract bump. `assertContractCompat` only
   * WARNS a provider built against an older contract, so on its own a v1 provider
   * claiming a v2 capability would boot and then crash mid-stream. This converts
   * that into a register-time failure.
   *
   * What v2 actually changed for a provider: `AIMessage.role` widened to include
   * `'tool'`, and an assistant turn may now carry `toolCalls`. Every added member is
   * optional, so a v1 provider object still satisfies the v2 interface and stays
   * welcome — the satellite simply never hands it a tool turn, because the chat
   * controller refuses a tool loop against a provider whose `capabilities.tools` is
   * not `true`. That leaves exactly one incoherent shape: a provider that CLAIMS
   * `capabilities.tools` while declaring a pre-v2 contract. Tool support IS the v2
   * contract, so such a provider cannot have known the tool wire shapes; honoring
   * its claim would route it tool turns it has no way to parse. It fails closed here
   * instead, at registration, where the operator can act on it.
   */
  assertShape(provider: AIProviderContract): void {
    if (provider.capabilities?.tools !== true) return
    const declared = provider.contractVersion ?? 0
    if (declared < 2) {
      // No Isthmus guard: this is a boot-time misconfiguration an operator fixes,
      // not a request-path refusal. `ai_streaming_capability` names the streaming
      // gate specifically, and the tool matrix is deliberately scoped to its six
      // request-path guards, so neither is honest to reuse or worth widening here.
      throw new Error(
        `ai provider "${provider.name}" declares capabilities.tools but was built against ` +
          `contract v${declared || '(unversioned)'}; tool calling is contract v2+. Declare ` +
          `contractVersion: ${AI_CONTRACT_VERSION} once it handles role:'tool' turns and ` +
          `assistant toolCalls, or drop capabilities.tools.`
      )
    }
  }

  /** Switch the active provider to the named one. Throws if not registered. */
  use(name: string): this {
    if (!this.#providers.has(name)) {
      throw new Error(
        `AIProviderRegistry: provider "${name}" is not registered. ` +
          `Available: ${[...this.#providers.keys()].join(', ') || '(none)'}`
      )
    }
    this.#activeName = name
    return this
  }

  /** The active default provider. Throws if none has been registered. */
  active(): AIProviderContract {
    if (!this.#activeName) {
      throw new Error(
        'AIProviderRegistry: no active provider. Register one in the AI provider before resolving.'
      )
    }
    const provider = this.#providers.get(this.#activeName)
    if (!provider) {
      throw new Error(`AIProviderRegistry: active provider "${this.#activeName}" was unregistered.`)
    }
    return provider
  }

  get(name: string): AIProviderContract | undefined {
    return this.#providers.get(name)
  }

  has(name: string): boolean {
    return this.#providers.has(name)
  }

  list(): readonly string[] {
    return [...this.#providers.keys()]
  }

  clear(): this {
    this.#providers.clear()
    this.#activeName = undefined
    return this
  }

  /**
   * Resolve the provider a tenant streams through, behind the default-deny
   * allow-list. The selection is isolated in
   * {@link resolveTenantProviderSelection} (the WS-AI-2 seam). Throws
   * `provider_unavailable` if the selected provider is not registered (e.g. its
   * key was unconfigured so it was never registered).
   */
  forTenant(tenant: TenantModelContract, config: AiConfig | undefined): AIProviderContract {
    const { provider } = resolveTenantProviderSelection(tenant, config)
    const resolved = this.#providers.get(provider)
    if (!resolved) {
      throw new AIException(
        'provider_unavailable',
        `ai provider "${provider}" is selected for the tenant but not registered`
      )
    }
    return resolved
  }
}

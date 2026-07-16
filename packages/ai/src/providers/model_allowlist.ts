import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import type { AIProviderName } from '../define_config.js'

/**
 * The G12 model gate, shared by the streaming and embedding provider families:
 * a requested model outside the per-provider `allowedModels` is refused
 * (default-deny, one level below the provider gate). This is the single
 * registered guard site for `guard.ai_model_allowlist`, so both a chat stream
 * and an embed run the same check and emit the same event before the throw.
 * `verb` (`stream` / `embed`) only shapes the message, never the guard id.
 */
export function assertModelAllowed(
  provider: AIProviderName,
  model: string,
  allowedModels: string[] | undefined,
  verb: string
): void {
  if (allowedModels && !allowedModels.includes(model)) {
    // Providers are tenant-agnostic by design, so this trip carries no tenant
    // id; the gateway's span/metrics already attribute the request.
    emitAiGuardEvent('guard.ai_model_allowlist', {
      metadata: { provider, model: model.slice(0, 64) },
    })
    throw new AIException(
      'provider_not_allowed',
      `Refusing to ${verb}: model "${model}" is not allow-listed for ${provider}`
    )
  }
}

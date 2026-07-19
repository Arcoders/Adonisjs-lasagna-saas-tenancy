import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AIInjectionConfig, InjectionVerdict } from '../define_config.js'
import type { EmitMetric } from './stream_extension.js'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import { AI_INJECTION_DETECTED_METRIC, AI_INJECTION_DETECTOR_ERROR_METRIC } from '../constants.js'

/**
 * One classifiable input: a piece of untrusted text and where it came from. The
 * `origin` is passed to the host classifier so it can weight a `user` turn
 * differently from a `retrieved` document or a `tool` result, and it labels the
 * guard/metric metadata (never the text itself).
 */
export interface InjectionInput {
  readonly text: string
  readonly origin: 'user' | 'retrieved' | 'tool'
}

/**
 * Run the host {@link AIInjectionConfig.classifier} over each input at the INPUT
 * pre-flight choke point (Wave 3, LLM01). This is DEFENSE-IN-DEPTH, never the
 * isolation control: the boundary is structural role separation plus I4, which holds
 * whether or not a classifier is wired, so the fail posture is split deliberately.
 *
 * - A `block` verdict is fail-CLOSED: it trips `guard.ai_injection_detected`, bumps
 *   the dedicated per-tenant `ai_injection_detected` counter, and throws
 *   `AIException('injection_detected')` (400, fatal). The caller rejects before any
 *   reserve, so a blocked request spends nothing and never retries the identical input.
 * - The classifier's OWN failure (a throw, or a return that is not a well-formed
 *   {@link InjectionVerdict}) is fail-OPEN by default: it bumps
 *   `ai_injection_detector_error` and proceeds, because an input detector is not the
 *   boundary and denying on its outage is availability damage for no security gain. A
 *   host that sets `onError: 'closed'` couples availability to the detector knowingly,
 *   and then the same failure trips `guard.ai_injection_detected` and refuses.
 *
 * Absent `classifier` is a no-op: with no semantic policy wired the structural
 * boundary is the only, and correct, default. Content is never logged: the guard/
 * metric carry only the `origin`, never the text or the classifier's `reason`.
 */
export async function enforceInjectionClassifier(
  ctx: HttpContext,
  tenant: TenantModelContract,
  injection: AIInjectionConfig | undefined,
  inputs: readonly InjectionInput[],
  emitMetric?: EmitMetric
): Promise<void> {
  const classifier = injection?.classifier
  if (!classifier) return
  const onError = injection?.onError ?? 'open'

  for (const input of inputs) {
    let verdict: InjectionVerdict | undefined
    let detectorFailed = false
    try {
      const raw = await classifier(ctx, tenant, { text: input.text, origin: input.origin })
      if (isVerdict(raw)) {
        verdict = raw
      } else {
        detectorFailed = true
      }
    } catch {
      // The classifier threw. It is NOT the boundary, so its own failure defaults to
      // fail-open; nothing about the tenant separation depends on it having run.
      detectorFailed = true
    }

    if (detectorFailed) {
      bestEffortMetric(emitMetric, tenant.id, AI_INJECTION_DETECTOR_ERROR_METRIC)
      if (onError === 'closed') {
        emitAiGuardEvent('guard.ai_injection_detected', {
          tenantId: tenant.id,
          metadata: { origin: input.origin, cause: 'detector_error' },
        })
        throw new AIException(
          'injection_detected',
          'Refusing the request: the injection classifier is unavailable and onError is closed'
        )
      }
      continue
    }

    if (verdict!.action === 'block') {
      emitAiGuardEvent('guard.ai_injection_detected', {
        tenantId: tenant.id,
        metadata: { origin: input.origin },
      })
      bestEffortMetric(emitMetric, tenant.id, AI_INJECTION_DETECTED_METRIC)
      throw new AIException(
        'injection_detected',
        'Refusing the request: input was flagged as prompt injection'
      )
    }
  }
}

/** A well-formed verdict is an object whose `action` is exactly `'allow'` or `'block'`. */
function isVerdict(value: unknown): value is InjectionVerdict {
  if (typeof value !== 'object' || value === null) return false
  const action = (value as { action?: unknown }).action
  return action === 'allow' || action === 'block'
}

/** Best-effort per-tenant metric: a failing sink can never touch the request path. */
function bestEffortMetric(
  emitMetric: EmitMetric | undefined,
  tenantId: string,
  name: string
): void {
  try {
    emitMetric?.(tenantId, name, 1)
  } catch {
    /* metrics are best-effort */
  }
}

import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../define_config.js'

/** The injection-posture reading, shared by the doctor check (info-only, no boot warning). */
export interface InjectionPosture {
  readonly code: 'ai_injection_classifier_wired' | 'ai_injection_structural_only'
  readonly severity: 'info'
  readonly message: string
}

/**
 * The single-voice reading of the input-injection posture. Returns
 * null when there is nothing to report (AI is not configured). Otherwise it always
 * reports `info`: whether a host `classifier` is wired, whether `scanRetrieved` is
 * on, and the `onError` posture. It NEVER warns, because the accepted default state
 * (no classifier, structural boundary only) is correct, not a misconfiguration.
 * Shipping a bundled semantic ruleset as a default would be the theater the design
 * rejects, so the honest move is to report the posture, not to fail a run over it.
 */
export function aiInjectionPosture(ai: AiConfig | undefined): InjectionPosture | null {
  if (!ai) return null
  const injection = ai.injection
  const classifierWired = typeof injection?.classifier === 'function'
  if (!classifierWired) {
    return {
      code: 'ai_injection_structural_only',
      severity: 'info',
      message:
        'AI injection detection: no config.ai.injection.classifier is wired, so the structural ' +
        'boundary (fence neutralization + user-role separation, invariant I4) is the only defense. ' +
        'This is the correct no-theater default; wire a host classifier for optional semantic ' +
        'defense-in-depth (it is never the isolation control).',
    }
  }
  const scanRetrieved = injection?.scanRetrieved === true
  const onError = injection?.onError ?? 'open'
  return {
    code: 'ai_injection_classifier_wired',
    severity: 'info',
    message:
      'AI injection detection: a host classifier is wired (defense-in-depth, NEVER the isolation ' +
      `control; structural role separation and a tenant-pure context are what isolate): scanRetrieved=${scanRetrieved}, ` +
      `onError='${onError}'. A block verdict refuses with a 400 injection_detected before any spend; ` +
      `with onError='${onError}' a classifier outage ${onError === 'closed' ? 'refuses traffic' : 'lets input through'}.`,
  }
}

/**
 * The `ai_injection` doctor check: keeps the input-injection posture visible to
 * operators, mirroring `aiRetrievalGateCheck`. Config is read through the injected
 * getter at RUN time, so it reports the live posture and unit-tests without an app.
 * Info-only by design: no posture here is a failure.
 */
export function aiInjectionCheck(getAiConfig: () => AiConfig | undefined): DoctorCheck {
  return {
    name: 'ai_injection',
    description:
      'Reports the AI input-injection posture: whether a host semantic classifier is wired ' +
      '(defense-in-depth), scanRetrieved, and the onError fail posture. The structural boundary ' +
      '(fence neutralization + role separation, I4) is always the isolation control.',

    run(): DiagnosisIssue[] {
      const posture = aiInjectionPosture(getAiConfig())
      if (posture === null) return []
      return [{ code: posture.code, severity: posture.severity, message: posture.message }]
    },
  }
}

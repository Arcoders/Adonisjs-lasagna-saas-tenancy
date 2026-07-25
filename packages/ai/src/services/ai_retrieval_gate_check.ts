import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../define_config.js'

/** The retrieval-posture reading shared by the boot warning and the doctor check. */
export interface RetrievalGatePosture {
  readonly code: 'ai_retrieval_gate_refused' | 'ai_retrieval_gate_acknowledged'
  readonly severity: 'warn' | 'info'
  readonly message: string
}

/**
 * The single-voice reading of the retrieval document-ACL posture,
 * shared by the boot warning and the `ai_retrieval_gate` doctor check so the two
 * never drift. Returns null when there is nothing to report: retrieval is not
 * usable (no embedding provider configured, so the retrieval routes cannot run),
 * or a per-user document ACL is wired.
 *
 * Retrieval is fail-closed (mirrors the mount gate). With embeddings on but no
 * `retrievalFilter`:
 * - not acknowledged: retrieval is REFUSED (every `/ai/retrieve` and RAG chat 403s)
 *   -> a `warn` telling the operator how to enable it.
 * - `acknowledgeUnscopedRetrieval === true`: retrieval runs tenant-wide -> an
 *   `info` that keeps the accepted risk on the operator's radar.
 */
export function aiRetrievalGatePosture(ai: AiConfig | undefined): RetrievalGatePosture | null {
  if (!ai?.embedding) return null
  if (ai.retrieval?.retrievalFilter) return null

  if (ai.acknowledgeUnscopedRetrieval === true) {
    return {
      code: 'ai_retrieval_gate_acknowledged',
      severity: 'info',
      message:
        'AI retrieval runs tenant-wide (acknowledged): no config.ai.retrieval.retrievalFilter ' +
        '(per-user document ACL, G2) is wired, so every user of a tenant can retrieve that ' +
        "tenant's ENTIRE corpus. Tenant isolation is unaffected; intra-tenant, per-user " +
        'document authorization is the host job.',
    }
  }
  return {
    code: 'ai_retrieval_gate_refused',
    severity: 'warn',
    message:
      'AI retrieval is fail-closed: no config.ai.retrieval.retrievalFilter (per-user document ' +
      'ACL, G2) is wired and config.ai.acknowledgeUnscopedRetrieval is not set, so every ' +
      '/ai/retrieve and RAG chat is refused with 403. Wire retrievalFilter for per-user ' +
      'scoping, or set acknowledgeUnscopedRetrieval to allow tenant-wide retrieval.',
  }
}

/**
 * The `ai_retrieval_gate` doctor check: keeps the retrieval authorization posture
 * visible to operators, speaking with the same voice as the boot warning (both
 * read {@link aiRetrievalGatePosture}). Config is read through the injected getter
 * at RUN time, so the check reports the live posture and unit-tests without an app.
 *
 * Postures:
 * - `retrievalFilter` wired, or retrieval not usable (no `config.ai.embedding`):
 *   healthy, no issue.
 * - Neither the ACL hook nor the acknowledgement: a `warn` issue (retrieval is
 *   refused until the host wires the hook or acknowledges the unscoped posture).
 * - Acknowledged tenant-wide opt-in: an `info` issue, so the accepted risk stays
 *   on the operator's radar without failing a diagnosis run.
 */
export function aiRetrievalGateCheck(getAiConfig: () => AiConfig | undefined): DoctorCheck {
  return {
    name: 'ai_retrieval_gate',
    description:
      'Reports the AI retrieval posture: the retrievalFilter per-user document ACL, the ' +
      'acknowledged tenant-wide opt-in, or the fail-closed default (retrieval refused).',

    run(): DiagnosisIssue[] {
      const posture = aiRetrievalGatePosture(getAiConfig())
      if (posture === null) return []
      return [{ code: posture.code, severity: posture.severity, message: posture.message }]
    },
  }
}

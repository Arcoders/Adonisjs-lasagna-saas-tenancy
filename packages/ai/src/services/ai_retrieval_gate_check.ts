import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../define_config.js'

/**
 * The single-voice risk wording for the retrieval document-ACL posture (WS-AI-5,
 * G2), shared by the boot warning and the `ai_retrieval_gate` doctor check so the
 * two never drift. Returns null when there is nothing to report: retrieval is not
 * usable (no embedding provider configured, so the retrieval routes cannot run),
 * or a per-user document ACL is wired.
 */
export function aiRetrievalGateRisk(ai: AiConfig | undefined): string | null {
  if (!ai?.embedding) return null
  if (ai.retrieval?.retrievalFilter) return null
  return (
    'AI retrieval runs tenant-wide: no config.ai.retrieval.retrievalFilter (per-user ' +
    "document ACL, G2) is wired, so every user of a tenant can retrieve that tenant's " +
    'ENTIRE corpus. Tenant isolation is unaffected; intra-tenant, per-user document ' +
    'authorization is the host job. Wire retrievalFilter, or set acknowledgeUnscopedRetrieval ' +
    'to accept this posture.'
  )
}

/**
 * The `ai_retrieval_gate` doctor check: keeps the retrieval authorization posture
 * visible to operators, speaking with the same voice as the boot warning (both
 * read {@link aiRetrievalGateRisk}). Config is read through the injected getter at
 * RUN time, so the check reports the live posture and unit-tests without an app.
 *
 * Postures:
 * - `retrievalFilter` wired, or retrieval not usable (no `config.ai.embedding`):
 *   healthy, no issue.
 * - Acknowledged tenant-wide opt-out: an `info` issue, so the accepted risk stays
 *   on the operator's radar without failing a diagnosis run.
 * - Neither the ACL hook nor the acknowledgement: a `warn` issue naming the
 *   consequence (every tenant user retrieves the whole corpus).
 */
export function aiRetrievalGateCheck(getAiConfig: () => AiConfig | undefined): DoctorCheck {
  return {
    name: 'ai_retrieval_gate',
    description:
      'Reports the AI retrieval posture: the retrievalFilter per-user document ACL, the ' +
      'acknowledged tenant-wide opt-out, or the unscoped default.',

    run(): DiagnosisIssue[] {
      const ai = getAiConfig()
      const risk = aiRetrievalGateRisk(ai)
      if (risk === null) return []

      if (ai?.acknowledgeUnscopedRetrieval === true) {
        return [
          {
            code: 'ai_retrieval_gate_acknowledged',
            severity: 'info',
            message: risk,
          },
        ]
      }
      return [
        {
          code: 'ai_retrieval_gate_unscoped',
          severity: 'warn',
          message: risk,
        },
      ]
    },
  }
}

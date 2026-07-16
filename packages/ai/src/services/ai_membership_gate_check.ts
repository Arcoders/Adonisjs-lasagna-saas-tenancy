import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../define_config.js'
import { aiMembershipGateRisk } from '../routes/mount_gate.js'

/**
 * The `ai_membership_gate` doctor check: keeps the AI authorization posture
 * visible to operators, speaking with the same voice as the mount-time
 * warning (both read {@link aiMembershipGateRisk}). Config is read through
 * the injected getter at RUN time, so the check reports the live posture and
 * unit-tests without an app.
 *
 * Postures:
 * - `authorizeAIAccess` wired, or no `config.ai` at all: healthy, no issue.
 * - Acknowledged opt-out: an `info` issue, so the accepted risk stays on the
 *   operator's radar without failing a diagnosis run.
 * - Neither hook nor acknowledgement: a `warn` issue naming the consequence
 *   (the mount gate refuses this posture at deploy time).
 */
export function aiMembershipGateCheck(getAiConfig: () => AiConfig | undefined): DoctorCheck {
  return {
    name: 'ai_membership_gate',
    description:
      'Reports the AI authorization posture: the authorizeAIAccess membership gate, the ' +
      'acknowledged opt-out, or the default-deny state the AI mount refuses.',

    run(): DiagnosisIssue[] {
      const ai = getAiConfig()
      const risk = aiMembershipGateRisk(ai)
      if (risk === null) return []

      if (ai?.acknowledgeNoMembershipGate === true) {
        return [
          {
            code: 'ai_membership_gate_acknowledged',
            severity: 'info',
            message: risk,
          },
        ]
      }
      return [
        {
          code: 'ai_membership_gate_missing',
          severity: 'warn',
          message: risk,
        },
      ]
    },
  }
}

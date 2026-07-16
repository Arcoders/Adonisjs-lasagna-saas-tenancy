import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig } from '../define_config.js'

/** A tool-calling posture reading: an issue naming the caveat, or null when nothing to report. */
export interface AiToolsPosture {
  readonly code: 'ai_tools_unauthorized' | 'ai_tools_acknowledged'
  readonly severity: 'warn' | 'info'
  readonly message: string
}

/**
 * The single-voice reading of the tool-calling authorization posture (WS-AI-11,
 * I7), shared by the boot warning and the `ai_tools` doctor check so the two never
 * drift. Returns null when there is nothing to report: tool calling is off (no
 * `config.ai.tools`), no tools are actually offered (neither a non-empty static
 * `registry` nor a `resolveTools` hook), or a per-tool `authorizeTool` ACL is wired.
 *
 * Tool calling is fail-closed (mirrors retrieval's G2 gate). With tools offered but
 * no `authorizeTool`:
 * - not acknowledged: every tool call is REFUSED (a 403 `tool_denied`) -> a `warn`
 *   telling the operator how to enable it.
 * - `acknowledgeUnauthorizedTools === true`: read tools run tenant-wide -> an `info`
 *   that keeps the accepted risk on the operator's radar. (Action tools ignore the
 *   acknowledgement; they need an explicit allow, and are refused until Phase 3a.)
 */
export function aiToolsPosture(ai: AiConfig | undefined): AiToolsPosture | null {
  const tools = ai?.tools
  if (!tools) return null
  const offersTools =
    (Array.isArray(tools.registry) && tools.registry.length > 0) ||
    typeof tools.resolveTools === 'function'
  if (!offersTools) return null
  if (typeof tools.authorizeTool === 'function') return null

  if (tools.acknowledgeUnauthorizedTools === true) {
    return {
      code: 'ai_tools_acknowledged',
      severity: 'info',
      message:
        'AI tool calling runs read tools tenant-wide (acknowledged): no ' +
        'config.ai.tools.authorizeTool (per-tool authorization, I7) is wired, so every user of a ' +
        "tenant can invoke that tenant's read tools. Tenant isolation is unaffected; intra-tenant, " +
        'per-user tool authorization is the host job. (Action tools ignore this acknowledgement.)',
    }
  }
  return {
    code: 'ai_tools_unauthorized',
    severity: 'warn',
    message:
      'AI tool calling is fail-closed: config.ai.tools offers tools but no ' +
      'config.ai.tools.authorizeTool (per-tool authorization, I7) is wired and ' +
      'config.ai.tools.acknowledgeUnauthorizedTools is not set, so every tool call is refused with ' +
      '403. Wire authorizeTool for per-tool scoping, or set acknowledgeUnauthorizedTools to run ' +
      'read tools tenant-wide.',
  }
}

/**
 * The `ai_tools` doctor check: keeps the tool-calling posture visible to
 * operators, speaking with the same voice as the boot warning (both read
 * {@link aiToolsPosture}). Config is read through the injected getter at RUN time,
 * so the check reports the live posture and unit-tests without an app.
 *
 * It reports up to two issues:
 * - the authorization posture ({@link aiToolsPosture}): a `warn` when tools are
 *   offered but refused (no hook, no acknowledgement), or an `info` for the
 *   acknowledged tenant-wide opt-in; nothing when the hook is wired or no tools
 *   are offered.
 * - an `info` when `config.ai.tools.actionTools.enabled` is set, stated honestly:
 *   action (mutating) tools are still refused unconditionally (the human-confirmation
 *   flow is not yet shipped), so the flag grants no writes today. This keeps an
 *   operator who set it from assuming mutations are live.
 */
export function aiToolsCheck(getAiConfig: () => AiConfig | undefined): DoctorCheck {
  return {
    name: 'ai_tools',
    description:
      'Reports the AI tool-calling posture (WS-AI-11): the authorizeTool per-tool ACL, the ' +
      'acknowledged tenant-wide opt-in, the fail-closed default (tool calls refused), and whether ' +
      'the action-tool flag is set.',

    run(): DiagnosisIssue[] {
      const ai = getAiConfig()
      const issues: DiagnosisIssue[] = []
      const posture = aiToolsPosture(ai)
      if (posture !== null) {
        issues.push({ code: posture.code, severity: posture.severity, message: posture.message })
      }
      if (ai?.tools?.actionTools?.enabled === true) {
        issues.push({
          code: 'ai_tools_action_enabled',
          severity: 'info',
          message:
            'config.ai.tools.actionTools.enabled is set, but the satellite still refuses every ' +
            "mode:'action' (mutating) tool: the human-in-the-loop confirmation flow that gates " +
            'writes is not yet available, so no model-driven mutation can occur regardless of this ' +
            'flag. Read tools are unaffected.',
        })
      }
      return issues
    },
  }
}

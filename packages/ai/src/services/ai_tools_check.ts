import type { DoctorCheck, DiagnosisIssue } from '@adonisjs-lasagna/saas-tenancy/services'
import type { AiConfig, AIToolHostDefinition } from '../define_config.js'

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
 *   acknowledgement; they need an explicit allow plus a human confirmation.)
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
 * It reports the authorization posture ({@link aiToolsPosture}) plus, when
 * `config.ai.tools.actionTools.enabled` is set, the action-tool posture (WS-AI-11
 * Phase 3a) via {@link aiActionToolIssues}: a `warn` when actions cannot actually
 * run (audit off, or a static registry action tool missing `summarizeArgs` / setting
 * `requiresConfirmation: false`), and an honest `info` when they can. A `resolveTools`
 * hook is per-request and cannot be boot-checked, so only the static registry is read.
 */
export function aiToolsCheck(getAiConfig: () => AiConfig | undefined): DoctorCheck {
  return {
    name: 'ai_tools',
    description:
      'Reports the AI tool-calling posture (WS-AI-11): the authorizeTool per-tool ACL, the ' +
      'acknowledged tenant-wide opt-in, the fail-closed default (tool calls refused), and the ' +
      'action-tool confirmation posture when actionTools.enabled is set.',

    run(): DiagnosisIssue[] {
      const ai = getAiConfig()
      const issues: DiagnosisIssue[] = []
      const posture = aiToolsPosture(ai)
      if (posture !== null) {
        issues.push({ code: posture.code, severity: posture.severity, message: posture.message })
      }
      if (ai && ai.tools?.actionTools?.enabled === true) {
        issues.push(...aiActionToolIssues(ai))
      }
      return issues
    },
  }
}

/**
 * The action-tool posture (WS-AI-11 Phase 3a), reported only when the kill-switch is
 * on. It surfaces the two ways a switched-on action still cannot run — the same two
 * the gate enforces at plan time — plus an honest note when it can:
 *
 * - audit off: the confirmation + at-most-once machinery is wired only when audit is
 *   on (an action's intent must be recorded before it runs), so with audit off every
 *   action is refused `tool_action_unavailable`. A `warn`, and the per-tool nits below
 *   are skipped because nothing can run anyway.
 * - a static registry action tool with no `summarizeArgs`: it is unadvertised and
 *   refused (`tool_action_disabled`), because a human cannot confirm against nothing.
 * - a static registry action tool with `requiresConfirmation: false`: refused, because
 *   with no confirmation there is no nonce to fence the effect by (at-most-once).
 * - otherwise: an `info` that action tools are live behind a human confirmation, with
 *   the honest limit (confirmation stops autonomous mutation, not prompt injection).
 */
export function aiActionToolIssues(ai: AiConfig): DiagnosisIssue[] {
  const issues: DiagnosisIssue[] = []

  if (ai.audit?.enabled === false) {
    issues.push({
      code: 'ai_tools_action_needs_audit',
      severity: 'warn',
      message:
        'config.ai.tools.actionTools.enabled is set but config.ai.audit.enabled is false. An action ' +
        'tool must durably record its intent BEFORE it runs, so the confirmation + at-most-once ' +
        'machinery is wired only when audit is on: with audit off every action is refused ' +
        '(tool_action_unavailable, 503). Enable audit to allow confirmed actions.',
    })
    return issues
  }

  // Only the STATIC registry can be inspected at boot; a resolveTools hook is dynamic.
  const registry = Array.isArray(ai.tools?.registry) ? ai.tools.registry : []
  const actionTools = registry.filter(
    (tool): tool is AIToolHostDefinition => tool.mode === 'action'
  )
  const noSummary = actionTools
    .filter((tool) => typeof tool.summarizeArgs !== 'function')
    .map((tool) => tool.name)
  const autoExecute = actionTools
    .filter((tool) => tool.requiresConfirmation === false)
    .map((tool) => tool.name)

  if (noSummary.length > 0) {
    issues.push({
      code: 'ai_tools_action_no_summary',
      severity: 'warn',
      message:
        `Action tool(s) [${noSummary.join(', ')}] ship no summarizeArgs, so a human cannot be shown ` +
        'what they would confirm: each is UNADVERTISED and refused at plan time ' +
        '(tool_action_disabled). Add a summarizeArgs that renders the one line the user reads before ' +
        'confirming.',
    })
  }
  if (autoExecute.length > 0) {
    issues.push({
      code: 'ai_tools_action_auto_execute',
      severity: 'warn',
      message:
        `Action tool(s) [${autoExecute.join(', ')}] set requiresConfirmation:false, which is refused ` +
        '(tool_action_disabled): with no confirmation there is no nonce to fence the effect by, so ' +
        'at-most-once cannot be guaranteed. Remove the flag to require a human confirmation.',
    })
  }

  issues.push({
    code: 'ai_tools_action_enabled',
    severity: 'info',
    message:
      'config.ai.tools.actionTools.enabled is set: a well-formed action (mutating) tool now runs ' +
      'after a human confirms it (WS-AI-11 Phase 3a). HONEST LIMIT: the confirmation stops an ' +
      'AUTONOMOUS mutation, not prompt injection — an injection can propose an action AND author ' +
      'text urging the human to confirm it, so keep action tools narrow and reversible. Only the ' +
      'static registry is boot-checked here; a resolveTools hook is per-request.',
  })
  return issues
}

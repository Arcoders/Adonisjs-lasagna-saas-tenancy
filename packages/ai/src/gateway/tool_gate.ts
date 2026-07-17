import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AIToolHostDefinition, AIToolsConfig, ToolScope } from '../define_config.js'
import type { AIToolDefinition } from '../types/ai_provider_contract.js'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
import {
  verifyToolConfirmation,
  type MintedConfirmation,
  type ToolConfirmationBinding,
} from './tool_confirmation.js'
import { MAX_TOOL_DEFS } from '../constants.js'

/**
 * The tool authorization + capability gates (WS-AI-11, Phase 3), the security
 * core of tool calling. Each function is pure of the loop and the executor, so a
 * spec (and the guard-emission matrix) drives it directly; each emits its own
 * Isthmus guard on the line before it throws, mirroring `access_gate.ts`. Every
 * gate is fail-closed and every refusal is a typed {@link AIException}, never a 500.
 */

/**
 * Resolve the FULL tool set available to a request, behind a per-tenant
 * default-deny (WS-AI-11, mirrors `allowedProviders`). Absent `config.ai.tools`
 * (or no `registry`/`resolveTools`) yields no tools. The static `registry` and
 * the dynamic `resolveTools` combine, first-wins by name; malformed entries are
 * dropped. This is the full set (read AND action) the executor gates a call
 * against; the advertised subset ({@link advertisedTools}) is what reaches the model.
 *
 * A `resolveTools` THROW is a refusal, not a 500 and not a silent tool-free chat:
 * the host's resolver is the per-tenant policy decision, so a resolver that cannot
 * decide (its policy backend is down) must not be read as "this tenant gets no
 * tools" — that would answer ungrounded as though tool calling were unavailable.
 * It denies with the pinned `tool_denied`, mirroring how `authorizeToolScope` and
 * `resolveRetrievalScope` treat their own host hooks failing.
 */
export async function resolveToolRegistry(
  ctx: HttpContext,
  tenant: TenantModelContract,
  toolsConfig: AIToolsConfig | undefined
): Promise<AIToolHostDefinition[]> {
  if (!toolsConfig) return []
  const out: AIToolHostDefinition[] = []
  const seen = new Set<string>()
  const add = (list: readonly AIToolHostDefinition[] | undefined): void => {
    for (const tool of list ?? []) {
      if (!isValidToolDefinition(tool) || seen.has(tool.name)) continue
      seen.add(tool.name)
      out.push(tool)
    }
  }
  add(toolsConfig.registry)
  if (toolsConfig.resolveTools) {
    let resolved: readonly AIToolHostDefinition[] | undefined
    try {
      resolved = await toolsConfig.resolveTools(ctx, tenant)
    } catch (error) {
      emitAiGuardEvent('guard.ai_tool_denied', {
        tenantId: tenant.id,
        metadata: { reason: 'resolver_error' },
      })
      throw new AIException(
        'tool_denied',
        'Refusing the tool call: the per-tenant tool resolver failed',
        { cause: error }
      )
    }
    add(resolved)
  }
  return out
}

/**
 * The wire-facing subset advertised to the model, capped at {@link MAX_TOOL_DEFS}
 * and stripped to the wire shape (no handler, no authz, no summarizer).
 *
 * Action tools appear only when the kill-switch is on. With it off they are not
 * merely refused at execution, they are never named to the model, so it cannot
 * propose one and the human is never shown a confirmation for a write the operator
 * has disabled. A malformed action tool (no `summarizeArgs`) is unadvertised too:
 * it can never be executed, so offering it would only produce a refusal the model
 * would then narrate to the user as a failure.
 */
export function advertisedTools(
  fullSet: readonly AIToolHostDefinition[],
  toolsConfig?: AIToolsConfig | undefined
): AIToolDefinition[] {
  const actionsOn = toolsConfig?.actionTools?.enabled === true
  return fullSet
    .filter((tool) => {
      if (tool.mode !== 'action') return true
      return actionsOn && typeof tool.summarizeArgs === 'function'
    })
    .slice(0, MAX_TOOL_DEFS)
    .map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }))
}

/**
 * Resolve a model-named tool against the tenant's registry. A name not in the
 * registry emits `guard.ai_tool_unknown` and throws `tool_unknown`: registering a
 * tool never auto-exposes it, and a hallucinated / probing name never executes.
 */
export function resolveKnownTool(
  tools: readonly AIToolHostDefinition[],
  name: string,
  tenantId: string
): AIToolHostDefinition {
  const tool = tools.find((candidate) => candidate.name === name)
  if (!tool) {
    emitAiGuardEvent('guard.ai_tool_unknown', {
      tenantId,
      metadata: { tool: String(name).slice(0, 64) },
    })
    throw new AIException('tool_unknown', 'Refusing the tool call: unknown tool')
  }
  return tool
}

/**
 * Refuse a mutating (`mode: 'action'`) tool unless the operator has switched action
 * tools on AND the tool is well-formed enough to be confirmed. A read tool passes
 * silently and never touches this.
 *
 * Two refusals, both `guard.ai_tool_action_disabled`, because from the caller's
 * side they are the same fact: this write cannot happen.
 *
 * 1. The kill-switch is off. One flag, every write off, however registered.
 * 2. The tool has no host-authored `summarizeArgs`. This looks like a config nit
 *    and is not: the human's decision is only as good as what they are shown, so a
 *    missing summary would mean confirming against either nothing or model-authored
 *    prose, and an injection that can write its own confirmation prompt has turned
 *    HITL into a rubber stamp. Refusing per tool is deliberate over a softer
 *    default: a doctor warning does not stop a rubber stamp that already shipped,
 *    and failing the whole boot would push hosts to switch confirmation off, which
 *    is worse than the thing being prevented.
 *
 * This does NOT check the confirmation itself. Whether a human agreed is decided
 * per call, against the arguments, by the executor.
 */
export function assertActionAllowed(
  tool: AIToolHostDefinition,
  tenantId: string,
  toolsConfig?: AIToolsConfig | undefined
): void {
  if (tool.mode !== 'action') return

  if (toolsConfig?.actionTools?.enabled !== true) {
    denyAction(tenantId, tool.name, 'kill_switch_off')
  }
  if (typeof tool.summarizeArgs !== 'function') {
    denyAction(tenantId, tool.name, 'no_args_summary')
  }
  if (tool.requiresConfirmation === false) {
    denyAction(tenantId, tool.name, 'auto_execute_unsupported')
  }
}

/** Emit `guard.ai_tool_action_disabled` and throw. Typed `never` so callers narrow. */
function denyAction(tenantId: string, toolName: string, reason: string): never {
  emitAiGuardEvent('guard.ai_tool_action_disabled', {
    tenantId,
    metadata: { tool: toolName.slice(0, 64), reason },
  })
  throw new AIException('tool_action_disabled', ACTION_REFUSALS[reason] ?? ACTION_REFUSALS.default!)
}

/**
 * One message per refusal reason, so a host reading a 403 learns which of the three
 * rules bit rather than a generic "disabled".
 */
const ACTION_REFUSALS: Record<string, string> = {
  no_args_summary:
    'Refusing the tool call: this action tool ships no summarizeArgs, so a human cannot be shown ' +
    'what they would be confirming',
  // `requiresConfirmation: false` is refused rather than honored, a deliberate
  // narrowing of Phase 3a. The at-most-once fence is keyed by the confirmation
  // token's own MAC, and what makes that correct is the token's random nonce: one
  // token, one effect. An auto-executing action has no token, so no nonce, and
  // nothing is left to key a fence by that behaves. Keyed by the arguments, a
  // deliberate repeat of the same action would be indistinguishable from a retry and
  // would vanish; keyed by anything fresh per call, it is not a fence at all.
  // At-most-once is not reachable without a nonce or a client-supplied idempotency
  // key, so the choice was a subtly wrong semantic or a refusal.
  auto_execute_unsupported:
    'Refusing the tool call: requiresConfirmation false is not supported yet. With no ' +
    'confirmation there is no nonce to fence the effect by, so it could not be guaranteed to ' +
    'happen only once.',
  default: 'Refusing the tool call: action (mutating) tools are disabled',
}

/**
 * Decide whether a human has agreed to THIS action call (WS-AI-11 Phase 3a).
 * Returns the confirmation that authorizes it; a read tool never reaches here.
 *
 * Every refusal is fail-closed and typed, and they are deliberately three different
 * codes, because from the client's side they need three different reactions:
 *
 * - `tool_action_unavailable` (503): the machinery is not wired, so the effect can
 *   be neither verified nor fenced. Nothing is wrong with the request.
 * - `tool_denied` (403): no principal resolved. A confirmation binds to a person,
 *   and one bound to nobody would be spendable by any session holding the string.
 * - `tool_confirmation_required` (428): no token was presented. This is NOT a
 *   failure, it is the first turn of every action, and the caller turns it into a
 *   challenge for the human.
 * - `tool_confirmation_invalid` (403): a token WAS presented and none authorized
 *   this call. The client believed it had permission and did not.
 *
 * The unmatched case emits `guard.ai_tool_confirmation_unmatched` at severity warn,
 * the same posture as `ai_rate_limited`: it fires in ordinary operation (the model
 * re-proposing different arguments lands here) so it is watched by rate, not per
 * event. Silence would be worse: without it, "our redaction ate the token" and "the
 * model rephrased a number" are the same non-signal forever.
 */
export function assertActionConfirmed(
  tool: AIToolHostDefinition,
  tenantId: string,
  binding: ToolConfirmationBinding | null,
  confirmations: readonly string[],
  macKey: Buffer | undefined,
  ledgerReady: boolean
): MintedConfirmation {
  if (!macKey || !ledgerReady) {
    throw new AIException(
      'tool_action_unavailable',
      'Refusing the action: the confirmation and at-most-once machinery is not wired, so the ' +
        'effect can be neither verified nor guaranteed to happen only once'
    )
  }
  if (!binding) {
    emitAiGuardEvent('guard.ai_tool_denied', {
      tenantId,
      metadata: { tool: tool.name.slice(0, 64), reason: 'action_requires_principal' },
    })
    throw new AIException(
      'tool_denied',
      'Refusing the action: it must be attributable to a principal, and none resolved'
    )
  }

  const confirmed = verifyToolConfirmation(macKey, confirmations, binding)
  if (confirmed) return confirmed

  if (confirmations.length > 0) {
    emitAiGuardEvent('guard.ai_tool_confirmation_unmatched', {
      tenantId,
      metadata: { tool: tool.name.slice(0, 64), presented: confirmations.length },
    })
    throw new AIException(
      'tool_confirmation_invalid',
      'Refusing the action: the confirmation presented does not authorize this call'
    )
  }
  throw new AIException(
    'tool_confirmation_required',
    'Refusing the action: it has not been confirmed'
  )
}

/**
 * Turn an action-ledger claim into a go / no-go. A `replay` means this exact
 * confirmation already fired, so the effect must not happen again.
 *
 * The two replay messages differ because the states differ in kind. A settled or
 * failed record is a clean "already used". A record still reading `claimed` means a
 * previous attempt never finished, so whether it took effect is genuinely unknown:
 * saying "already done" could be a lie and saying "it failed" would invite a retry
 * that doubles it. The honest answer is to tell the human to decide again, which
 * mints a fresh token and a fresh effect.
 */
export function assertClaimUsable(
  claim: { kind: 'claimed' } | { kind: 'replay'; state: 'claimed' | 'settled' | 'failed' },
  tenantId: string,
  toolName: string
): void {
  if (claim.kind === 'claimed') return
  emitAiGuardEvent('guard.ai_tool_confirmation_unmatched', {
    tenantId,
    metadata: { tool: toolName.slice(0, 64), reason: `replay_${claim.state}` },
  })
  throw new AIException(
    'tool_confirmation_invalid',
    claim.state === 'claimed'
      ? 'Refusing the action: an earlier attempt with this confirmation did not finish, so ' +
          'whether it took effect is unknown. Start again to make a fresh decision.'
      : 'Refusing the action: this confirmation has already been used'
  )
}

/**
 * Resolve the per-tool authorization scope, mirroring `resolveRetrievalScope`.
 * Fail-closed: an absent hook denies unless `acknowledgeUnauthorizedTools` is set;
 * a throw, an invalid return, or an explicit `{ kind: 'deny' }` all deny with
 * `guard.ai_tool_denied` and a `tool_denied` (403), never a 500. Returns the
 * `{ kind: 'allow', filter? }` scope on success.
 *
 * An ACTION tool ignores `acknowledgeUnauthorizedTools` (WS-AI-11 Phase 3a). That
 * escape hatch exists so a host can try read tools out without wiring authorization
 * first, where tenant isolation still holds and the worst case is reading its own
 * data. Extending the same convenience to writes would mean one boolean, set once
 * for a demo, silently authorizing every mutation the model can think of. An action
 * tool needs a real hook that really said allow.
 *
 * Takes the tool rather than its name so the mode comes from the definition itself:
 * a caller cannot pass the wrong one, or forget it and get the weaker path.
 */
export async function authorizeToolScope(
  ctx: HttpContext,
  tenant: TenantModelContract,
  tool: Pick<AIToolHostDefinition, 'name' | 'mode'>,
  toolsConfig: AIToolsConfig | undefined
): Promise<ToolScope> {
  const toolName = tool.name
  const hook = toolsConfig?.authorizeTool
  if (!hook) {
    if (toolsConfig?.acknowledgeUnauthorizedTools === true && tool.mode !== 'action') {
      return { kind: 'allow' }
    }
    denyTool(
      tenant.id,
      toolName,
      tool.mode === 'action' ? 'action_requires_authorizer' : 'unauthorized_unacknowledged'
    )
  }

  let scope: unknown
  try {
    scope = await hook(ctx, tenant, toolName)
  } catch (error) {
    denyTool(tenant.id, toolName, 'hook_error', error)
  }
  if (!isToolScope(scope)) denyTool(tenant.id, toolName, 'invalid_scope')
  if (scope.kind === 'deny') denyTool(tenant.id, toolName, 'denied')
  return scope
}

/**
 * The I7 / confused-deputy re-assertion, called by the executor BEFORE it binds
 * `tenancy.run(tenant)`: if the request is already running inside a tenancy scope
 * it MUST be this tenant's. Reading the AMBIENT scope before the bind (not after,
 * which would compare the just-set scope to itself — a tautology) is what makes the
 * check meaningful and faithfully mirrors the vector-store `#target` and
 * audit-writer `append` re-assert. A breach emits the CRITICAL
 * `guard.ai_tool_scope_mismatch` and throws `tenant_scope_mismatch`, so a
 * confused-deputy call running inside another tenant's scope cannot reach this
 * tenant's handler. `undefined` (no ambient scope, the normal streaming path)
 * trusts the caller; the kernel ContextSeal is the per-query backstop.
 */
export function assertActiveToolScope(active: string | undefined, tenantId: string): void {
  if (active !== undefined && active !== tenantId) {
    emitAiGuardEvent('guard.ai_tool_scope_mismatch', {
      tenantId,
      metadata: { active: String(active).slice(0, 64) },
    })
    throw new AIException(
      'tenant_scope_mismatch',
      'Refusing the tool call: the request tenant does not match the active tenancy scope'
    )
  }
}

/** Whether a value is a well-formed {@link ToolScope} (a wired hook must return one). */
export function isToolScope(value: unknown): value is ToolScope {
  if (typeof value !== 'object' || value === null) return false
  const scope = value as { kind?: unknown; filter?: unknown }
  if (scope.kind === 'deny') return true
  if (scope.kind === 'allow') {
    return (
      scope.filter === undefined ||
      (typeof scope.filter === 'object' && scope.filter !== null && !Array.isArray(scope.filter))
    )
  }
  return false
}

/** Emit `guard.ai_tool_denied` and throw `tool_denied`. Typed `never` so callers narrow. */
function denyTool(tenantId: string, toolName: string, reason: string, cause?: unknown): never {
  emitAiGuardEvent('guard.ai_tool_denied', {
    tenantId,
    metadata: { tool: String(toolName).slice(0, 64), reason },
  })
  throw new AIException(
    'tool_denied',
    'Refusing the tool call: not authorized',
    cause !== undefined ? { cause } : undefined
  )
}

/** Defensive shape check: a registry entry missing a name, description, schema or handler is dropped. */
function isValidToolDefinition(tool: unknown): tool is AIToolHostDefinition {
  if (typeof tool !== 'object' || tool === null) return false
  const t = tool as Partial<AIToolHostDefinition>
  return (
    typeof t.name === 'string' &&
    t.name.length > 0 &&
    typeof t.description === 'string' &&
    typeof t.inputSchema === 'object' &&
    t.inputSchema !== null &&
    typeof t.handler === 'function'
  )
}

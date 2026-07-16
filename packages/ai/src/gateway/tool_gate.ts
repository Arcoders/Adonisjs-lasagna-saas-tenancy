import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { AIToolHostDefinition, AIToolsConfig, ToolScope } from '../define_config.js'
import type { AIToolDefinition } from '../types/ai_provider_contract.js'
import AIException from '../exceptions/ai_exception.js'
import { emitAiGuardEvent } from '../isthmus/ai_guard_audit.js'
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
 * The wire-facing subset advertised to the model: read tools only (action tools
 * are never advertised while the kill-switch is off, which is until Phase 3a),
 * capped at {@link MAX_TOOL_DEFS}, stripped to the wire shape (no handler / authz).
 */
export function advertisedTools(fullSet: readonly AIToolHostDefinition[]): AIToolDefinition[] {
  return fullSet
    .filter((tool) => tool.mode !== 'action')
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
 * Refuse a mutating (`mode: 'action'`) tool. Action tools are OFF by default and,
 * until the confirmation flow ships (Phase 3a), refused unconditionally with
 * `guard.ai_tool_action_disabled`, so an indirect injection can propose a write
 * but never perform one. A read tool passes silently.
 */
export function assertActionAllowed(tool: AIToolHostDefinition, tenantId: string): void {
  if (tool.mode === 'action') {
    emitAiGuardEvent('guard.ai_tool_action_disabled', {
      tenantId,
      metadata: { tool: tool.name.slice(0, 64) },
    })
    throw new AIException(
      'tool_action_disabled',
      'Refusing the tool call: action (mutating) tools are disabled'
    )
  }
}

/**
 * Resolve the per-tool authorization scope, mirroring `resolveRetrievalScope`.
 * Fail-closed: an absent hook denies unless `acknowledgeUnauthorizedTools` is set;
 * a throw, an invalid return, or an explicit `{ kind: 'deny' }` all deny with
 * `guard.ai_tool_denied` and a `tool_denied` (403), never a 500. Returns the
 * `{ kind: 'allow', filter? }` scope on success.
 */
export async function authorizeToolScope(
  ctx: HttpContext,
  tenant: TenantModelContract,
  toolName: string,
  toolsConfig: AIToolsConfig | undefined
): Promise<ToolScope> {
  const hook = toolsConfig?.authorizeTool
  if (!hook) {
    if (toolsConfig?.acknowledgeUnauthorizedTools === true) return { kind: 'allow' }
    denyTool(tenant.id, toolName, 'unauthorized_unacknowledged')
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

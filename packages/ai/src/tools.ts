import type {
  AIToolAuthorizer,
  AIToolHostDefinition,
  AIToolResolver,
  AIToolsConfig,
  ToolContext,
  ToolScope,
} from './define_config.js'

/**
 * The public tool-authoring surface, exposed on the `./tools` subpath.
 * It ships ONLY erased authoring types and pure helpers, so a host can import it
 * from `config/multitenancy.ts` (which loads before boot) exactly like the main
 * barrel: there is no Adonis service singleton, no container, and no router here.
 * The container/router-bound machinery (the tool loop, the executor service) is
 * wired by the provider and resolved by `./routes`, never imported by a host.
 *
 * @example
 *   // config/multitenancy.ts
 *   import { readOnlyTool } from '@adonisjs-lasagna/ai/tools'
 *
 *   tools: {
 *     registry: [
 *       readOnlyTool(
 *         'count_bookings',
 *         "Count this tenant's bookings, optionally filtered by status.",
 *         { type: 'object', properties: { status: { type: 'string' } } },
 *         async ({ status }) => ({ total: await Booking.query().count() })
 *       ),
 *     ],
 *     authorizeTool: () => ({ kind: 'allow' }),
 *   }
 */

export type {
  AIToolAuthorizer,
  AIToolHostDefinition,
  AIToolResolver,
  AIToolsConfig,
  ToolContext,
  ToolScope,
} from './define_config.js'
export type { AIToolCall, AIToolDefinition } from './types/ai_provider_contract.js'

// The prototype-safe, dependency-free argument validator, re-exported for a host
// that wants to validate a tool's arguments outside the loop (e.g. in a test).
// Pure: it emits a guard + throws on refusal and never touches a container.
export { validateToolInput } from './gateway/tool_input.js'

/**
 * Identity helper for authoring one tool with full type-checking + IDE
 * autocomplete against {@link AIToolHostDefinition}. No runtime effect; it only
 * fixes the inference so a malformed `handler` or `inputSchema` is a compile
 * error at the definition site rather than a boot-time validation failure.
 */
export function defineTool(tool: AIToolHostDefinition): AIToolHostDefinition {
  return tool
}

/**
 * Identity helper for authoring a whole tool registry (the array a host assigns
 * to `config.ai.tools.registry`), type-checked element by element. No runtime
 * effect. Pairs with `defineAiConfig` the way a registry pairs with the config
 * block that carries it.
 */
export function defineAiTools(tools: AIToolHostDefinition[]): AIToolHostDefinition[] {
  return tools
}

/**
 * The ergonomic minimal path: a read-only tool in one call. Everything the full
 * {@link AIToolHostDefinition} surface exposes defaults safely: `mode` is
 * `'read'` (never a mutating action tool), the loop bounds come from the named
 * constants, and arguments are validated by the shipped JSON-Schema-subset
 * checker (no host `parseInput` needed). Reach for the full object form only when
 * a tool needs an action mode, a custom `parseInput`, or per-tool confirmation.
 *
 * @param name         The tool name the model calls (must match the registry).
 * @param description  What the tool does, read by the model to decide when to call it.
 * @param inputSchema  A JSON-Schema object the model formats arguments against.
 * @param handler      Runs INSIDE `tenancy.run(tenant)` with the request's {@link ToolContext}.
 */
export function readOnlyTool(
  name: string,
  description: string,
  inputSchema: Readonly<Record<string, unknown>>,
  handler: (args: Record<string, unknown>, context: ToolContext) => Promise<unknown>
): AIToolHostDefinition {
  return { name, description, inputSchema, mode: 'read', handler }
}

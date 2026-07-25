import AiChatController from '../../src/gateway/ai_chat_controller.js'
import AIProviderRegistry from '../../src/services/ai_provider_registry.js'
import TenantLivenessWatcher from '../../src/services/tenant_liveness_watcher.js'
import ToolExecutorService from '../../src/services/tool_executor.js'
import type AiActionLedger from '../../src/services/action_ledger.js'
import { deriveAiToolConfirmationMacKey } from '../../src/gateway/tool_confirmation.js'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../../src/gateway/idempotency.js'
import MockAIProvider from '../../src/testing/mock_ai_provider.js'
import { FakeQuota, makeService, fakeTenant } from './stream_doubles.js'
import type { AiConfig, AIToolHostDefinition, AIToolsConfig } from '../../src/define_config.js'
import type { StreamFragment } from '../../src/types/ai_provider_contract.js'

/**
 * The controller-level tool-loop harness: a REAL
 * `AiChatController` + `StreamExtensionService` + `ToolExecutorService` + tool
 * loop, driven offline by `MockAIProvider`'s multi-round script. Only the tenancy
 * pair, the quota and the idempotency store are doubles, so a spec exercises the
 * wiring the route performs rather than a re-implementation of it.
 */

/** A `tool_call` fragment shaped exactly as the wire parsers emit one. */
export function toolCallFragment(id: string, name: string, args: string): StreamFragment {
  return { data: '', tokens: 0, event: 'tool_call', toolCall: { id, name, arguments: args } }
}

/** What the reference tool handler saw on one invocation. */
export interface ToolHandlerCall {
  readonly name: string
  readonly args: Record<string, unknown>
  /** The tenancy scope bound AROUND the handler; proves it ran inside `runScoped`. */
  readonly scopeTenantId: string | undefined
  /** The narrowing filter an `allow` scope carried, if any. */
  readonly filter: Record<string, unknown> | undefined
}

/** A quota double that records every reservation worst case, for the aggregate-budget specs. */
export class RecordingQuota extends FakeQuota {
  readonly reserves: number[] = []
  override async reserve(_tenant?: unknown, _quota?: unknown, worstCase?: number) {
    if (typeof worstCase === 'number') this.reserves.push(worstCase)
    return super.reserve()
  }
}

export interface BuildToolChatOptions {
  /** Merged over the default tools config (a single read tool, authorized). */
  tools?: Partial<AIToolsConfig>
  /** The provider's per-round script. Default: round 1 calls the tool, round 2 answers. */
  rounds?: StreamFragment[][]
  /** Drop `config.ai.tools` entirely, the plain-chat control. */
  toolFree?: boolean
  /** Leave the executor dep unwired, as the route does for a host without tools. */
  wireExecutor?: boolean
  /** Force the provider's declared `capabilities.tools` (default: true, via `rounds`). */
  providerDeclaresTools?: boolean
  /** Share an idempotency store across two controller calls (the replay specs). */
  store?: AiIdempotencyStore
  /** Share a watcher across calls (the concurrency-cap spec). */
  liveness?: TenantLivenessWatcher
  /** Wire the confirmation MAC key + an in-memory action ledger into the executor. */
  actionMachinery?: boolean
}

export interface ToolChatHarness {
  controller: AiChatController
  provider: MockAIProvider
  quota: RecordingQuota
  liveness: TenantLivenessWatcher
  /** Every reference-tool invocation, in order. */
  handlerCalls: ToolHandlerCall[]
  toolsConfig: AIToolsConfig
}

/** An in-memory idempotency store, shareable across calls to drive a replay. */
export function mapIdempotencyStore(): AiIdempotencyStore {
  const data = new Map<string, string>()
  return {
    async get(tenantId, key) {
      return data.get(`${tenantId}|${key}`)
    },
    async set(tenantId, key, value) {
      data.set(`${tenantId}|${key}`, value)
    },
  }
}

export function buildToolChat(options: BuildToolChatOptions = {}): ToolChatHarness {
  const handlerCalls: ToolHandlerCall[] = []
  // The ambient tenancy scope, as `tenancy.run` / `tenancy.currentId` present it:
  // pushed around the handler only, so the executor's I7 re-assert reads an
  // UNBOUND ambient scope on the normal path, exactly like the real kernel.
  const scopeStack: string[] = []

  const countBookings: AIToolHostDefinition = {
    name: 'count_bookings',
    description: 'Count this tenant bookings, optionally narrowed by status.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' } },
    },
    mode: 'read',
    handler: async (args, context) => {
      handlerCalls.push({
        name: 'count_bookings',
        args,
        scopeTenantId: scopeStack.at(-1),
        filter: context.filter,
      })
      return { total: 4 }
    },
  }

  const toolsConfig: AIToolsConfig = {
    registry: [countBookings],
    authorizeTool: () => ({ kind: 'allow' }),
    ...options.tools,
  }

  const rounds = options.rounds ?? [
    [toolCallFragment('call-1', 'count_bookings', '{"status":"active"}')],
    [{ data: 'tienes 4 reservas', tokens: 3 }],
  ]

  const provider = new MockAIProvider({
    name: 'claude',
    contractVersion: 2,
    rounds,
    ...(options.providerDeclaresTools !== undefined
      ? { tools: options.providerDeclaresTools }
      : {}),
  })
  const registry = new AIProviderRegistry()
  registry.register(provider, { activate: true })

  const config = {
    allowedProviders: ['claude'],
    authorizeAIAccess: () => true,
    ...(options.toolFree ? {} : { tools: toolsConfig }),
  } as AiConfig

  const executor = new ToolExecutorService({
    runScoped: async (tenant, fn) => {
      scopeStack.push(tenant.id)
      try {
        return await fn()
      } finally {
        scopeStack.pop()
      }
    },
    activeScopeTenantId: () => scopeStack.at(-1),
    getToolsConfig: () => toolsConfig,
    ...(options.actionMachinery
      ? {
          confirmationMacKey: deriveAiToolConfirmationMacKey('tool-chat-doubles-app-key-000000!'),
          actionLedger: stubActionLedger(),
        }
      : {}),
  })

  const quota = new RecordingQuota()
  const { svc } = makeService(quota)
  const liveness = options.liveness ?? new TenantLivenessWatcher()
  const controller = new AiChatController({
    stream: svc,
    registry,
    idempotency: new AiIdempotencyService({
      store: options.store ?? mapIdempotencyStore(),
      macKey: deriveAiIdempotencyMacKey('test-app-key'),
    }),
    liveness,
    tools: options.wireExecutor === false ? undefined : executor,
    config,
  })

  return { controller, provider, quota, liveness, handlerCalls, toolsConfig }
}

/**
 * An in-memory at-most-once ledger for the controller harness. A challenge never
 * claims it (only a confirmed run does), so a challenge test never exercises it; a
 * confirmed run fences by the effect key exactly once.
 */
function stubActionLedger(): AiActionLedger {
  const claimed = new Set<string>()
  return {
    claim: async (_tenantId: string, effectKey: string) => {
      if (claimed.has(effectKey)) return { kind: 'replay', state: 'settled' }
      claimed.add(effectKey)
      return { kind: 'claimed' }
    },
    settle: async () => {},
    fail: async () => {},
  } as unknown as AiActionLedger
}

/** The canonical chat body + the tenant the harness resolves. */
export const toolChatBody = { messages: [{ role: 'user', content: '¿cuántas reservas tengo?' }] }
export { fakeTenant }

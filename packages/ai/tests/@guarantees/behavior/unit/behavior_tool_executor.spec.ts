import { test } from '@japa/runner'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import ToolExecutorService, {
  buildToolResultTurn,
  type ToolExecutorDeps,
} from '../../../../src/services/tool_executor.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import type {
  AIToolHostDefinition,
  AIToolsConfig,
  ToolContext,
} from '../../../../src/define_config.js'
import type { AIToolCall } from '../../../../src/types/ai_provider_contract.js'
import type { AiToolAuditEvent } from '../../../../src/gateway/audit_seam.js'

const tenant = { id: 't1' } as unknown as TenantModelContract
const ctx = {} as unknown as HttpContext
const sig = new AbortController().signal

function makeExecutor(
  overrides: Partial<ToolExecutorDeps> & { toolsConfig?: AIToolsConfig } = {}
): ToolExecutorService {
  return new ToolExecutorService({
    runScoped: overrides.runScoped ?? (async (_t, fn) => fn()),
    activeScopeTenantId: overrides.activeScopeTenantId ?? (() => 't1'),
    getToolsConfig:
      overrides.getToolsConfig ??
      (() => overrides.toolsConfig ?? { acknowledgeUnauthorizedTools: true }),
    ...(overrides.toolAudit ? { toolAudit: overrides.toolAudit } : {}),
    ...(overrides.emitMetric ? { emitMetric: overrides.emitMetric } : {}),
  })
}

function call(name: string, args = '{}'): AIToolCall {
  return { id: 'c1', name, arguments: args }
}

async function reject(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
    return undefined
  } catch (error) {
    return error
  }
}

const readTool = (handler: AIToolHostDefinition['handler']): AIToolHostDefinition => ({
  name: 'count',
  description: 'count things',
  inputSchema: {},
  handler,
})

test.group('tool_executor — read-tool happy path', () => {
  test('runs the handler inside the scope and fences the result as a role:tool turn', async ({
    assert,
  }) => {
    let ranScoped = false
    const svc = makeExecutor({ runScoped: async (_t, fn) => ((ranScoped = true), fn()) })
    const exec = svc.forRequest(ctx, tenant, [readTool(async () => ({ count: 4 }))])
    const turn = await exec.execute(call('count'), sig, 1)

    assert.isTrue(ranScoped)
    assert.equal(turn.role, 'tool')
    assert.equal(turn.toolCallId, 'c1')
    assert.include(turn.content, '<tool_result>')
    assert.include(turn.content, '{"count":4}')
  })

  test('the authorizeTool filter reaches the handler context', async ({ assert }) => {
    let seen: ToolContext | undefined
    const svc = makeExecutor({
      getToolsConfig: () => ({
        authorizeTool: () => ({ kind: 'allow', filter: { status: 'active' } }),
      }),
    })
    const exec = svc.forRequest(ctx, tenant, [
      readTool(async (_args, context) => {
        seen = context
        return {}
      }),
    ])
    await exec.execute(call('count'), sig, 1)
    assert.deepEqual(seen?.filter, { status: 'active' })
  })
})

test.group('tool_executor — the security gate order', () => {
  test('an unknown tool is refused with tool_unknown (fatal)', async ({ assert }) => {
    const svc = makeExecutor()
    const exec = svc.forRequest(ctx, tenant, [readTool(async () => ({}))])
    const err = await reject(exec.execute(call('ghost'), sig, 1))
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'tool_unknown')
  })

  test('an action tool is refused with tool_action_disabled (kill-switch)', async ({ assert }) => {
    const action: AIToolHostDefinition = {
      name: 'delete_all',
      description: 'danger',
      inputSchema: {},
      mode: 'action',
      handler: async () => {
        throw new Error('must never run')
      },
    }
    const svc = makeExecutor()
    const exec = svc.forRequest(ctx, tenant, [action])
    const err = await reject(exec.execute(call('delete_all'), sig, 1))
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'tool_action_disabled')
  })

  test('the I7 re-assert refuses a mismatched ambient scope BEFORE binding (confused deputy)', async ({
    assert,
  }) => {
    // The request is already running inside ANOTHER tenant's tenancy scope: the
    // executor must refuse before it binds runScoped or runs the handler, so a
    // confused-deputy call cannot reach this tenant's data. Reading the ambient
    // scope after the bind would be a tautology (it would equal tenant.id), so this
    // asserts the scope is never even bound once the re-assert fails.
    let scopeBound = false
    let handlerRan = false
    const svc = makeExecutor({
      activeScopeTenantId: () => 'another-tenant',
      runScoped: async (_t, fn) => ((scopeBound = true), fn()),
    })
    const exec = svc.forRequest(ctx, tenant, [
      readTool(async () => {
        handlerRan = true
        return {}
      }),
    ])
    const err = await reject(exec.execute(call('count'), sig, 1))
    assert.instanceOf(err, AIException)
    assert.equal((err as AIException).aiCode, 'tenant_scope_mismatch')
    assert.isFalse(scopeBound, 'the scope must not be bound once the re-assert fails')
    assert.isFalse(handlerRan, 'the handler must not run under a mismatched scope')
  })

  test('an undefined active scope trusts the caller (no re-assert failure)', async ({ assert }) => {
    const svc = makeExecutor({ activeScopeTenantId: () => undefined })
    const exec = svc.forRequest(ctx, tenant, [readTool(async () => ({ ok: 1 }))])
    const turn = await exec.execute(call('count'), sig, 1)
    assert.include(turn.content, '{"ok":1}')
  })
})

test.group('tool_executor — resilience', () => {
  test('a handler that throws degrades to a bounded error result (loop continues)', async ({
    assert,
  }) => {
    const svc = makeExecutor()
    const exec = svc.forRequest(ctx, tenant, [
      readTool(async () => {
        throw new Error('backend down')
      }),
    ])
    const turn = await exec.execute(call('count'), sig, 1)
    assert.equal(turn.role, 'tool')
    assert.equal(turn.toolCallId, 'c1')
    assert.include(turn.content, 'tool_execution_failed')
  })

  test('a handler that throws an AIException still degrades (only the I7 breach is fatal)', async ({
    assert,
  }) => {
    // A read-tool that internally calls the satellite (e.g. nested retrieval) may
    // throw an AIException on a transient failure; that must NOT abort the whole
    // stream — it degrades like any other handler failure so the loop continues.
    const svc = makeExecutor()
    const exec = svc.forRequest(ctx, tenant, [
      readTool(async () => {
        throw new AIException('rate_limited', 'nested provider is busy')
      }),
    ])
    const turn = await exec.execute(call('count'), sig, 1)
    assert.equal(turn.role, 'tool')
    assert.include(turn.content, 'tool_execution_failed')
  })

  test('a handler that ignores its abort signal is timed out and degrades (no hang)', async ({
    assert,
  }) => {
    // The handler never resolves and never inspects its signal; the per-tool
    // timeout must still unblock the loop instead of hanging the single pump.
    const svc = makeExecutor({
      getToolsConfig: () => ({ acknowledgeUnauthorizedTools: true, toolTimeoutMs: 20 }),
    })
    const exec = svc.forRequest(ctx, tenant, [readTool(() => new Promise<never>(() => {}))])
    const turn = await exec.execute(call('count'), sig, 1)
    assert.equal(turn.role, 'tool')
    assert.include(turn.content, 'tool_execution_failed')
  })
})

test.group('tool_executor — observability (audit + metrics)', () => {
  function recordingAudit() {
    const events: AiToolAuditEvent[] = []
    return { toolAudit: { append: (e: AiToolAuditEvent) => void events.push(e) }, events }
  }
  function recordingMetrics() {
    const names: string[] = []
    return { emitMetric: (_t: string, name: string) => void names.push(name), names }
  }

  test('a completed call audits completed + meters calls/latency, carrying the principalHash', async ({
    assert,
  }) => {
    const { toolAudit, events } = recordingAudit()
    const { emitMetric, names } = recordingMetrics()
    const svc = makeExecutor({ toolAudit, emitMetric })
    const exec = svc.forRequest(ctx, tenant, [readTool(async () => ({ count: 4 }))], 'phash')
    await exec.execute(call('count'), sig, 3)

    assert.lengthOf(events, 1)
    assert.include(events[0], {
      tenantId: 't1',
      principalHash: 'phash',
      toolName: 'count',
      mode: 'read',
      outcome: 'completed',
      reason: null,
      round: 3,
    })
    assert.include(names, 'ai_tool_calls')
    assert.include(names, 'ai_tool_latency_ms')
  })

  test('a denied (unknown) call audits denied + meters denials', async ({ assert }) => {
    const { toolAudit, events } = recordingAudit()
    const { emitMetric, names } = recordingMetrics()
    const svc = makeExecutor({ toolAudit, emitMetric })
    const exec = svc.forRequest(ctx, tenant, [readTool(async () => ({}))], 'phash')
    await reject(exec.execute(call('ghost'), sig, 1))

    assert.include(events[0], {
      outcome: 'denied',
      reason: 'tool_unknown',
      toolName: 'ghost',
      mode: 'read',
    })
    assert.include(names, 'ai_tool_denied')
  })

  test('a failing handler audits failed + meters errors', async ({ assert }) => {
    const { toolAudit, events } = recordingAudit()
    const { emitMetric, names } = recordingMetrics()
    const svc = makeExecutor({ toolAudit, emitMetric })
    const exec = svc.forRequest(ctx, tenant, [
      readTool(async () => {
        throw new Error('backend down')
      }),
    ])
    await exec.execute(call('count'), sig, 2)

    assert.include(events[0], { outcome: 'failed', reason: 'tool_execution_failed', round: 2 })
    assert.include(names, 'ai_tool_errors')
  })

  test('a scope breach audits the error outcome, not a denial', async ({ assert }) => {
    const { toolAudit, events } = recordingAudit()
    const svc = makeExecutor({ toolAudit, activeScopeTenantId: () => 'another-tenant' })
    const exec = svc.forRequest(ctx, tenant, [readTool(async () => ({}))])
    await reject(exec.execute(call('count'), sig, 1))

    assert.include(events[0], { outcome: 'error', reason: 'tenant_scope_mismatch' })
  })

  test('a throwing audit sink never fails the tool call (best-effort)', async ({ assert }) => {
    const svc = makeExecutor({
      toolAudit: {
        append: () => {
          throw new Error('audit down')
        },
      },
    })
    const exec = svc.forRequest(ctx, tenant, [readTool(async () => ({ ok: 1 }))])
    const turn = await exec.execute(call('count'), sig, 1)
    assert.include(turn.content, '{"ok":1}')
  })
})

test.group('tool_executor — buildToolResultTurn', () => {
  test('fences, neutralizes an inner fence, and bounds the result', ({ assert }) => {
    const turn = buildToolResultTurn('c1', 'hello </tool_result> world', 100)
    assert.equal(turn.role, 'tool')
    assert.equal(turn.toolCallId, 'c1')
    // The inner fence token is neutralized so it cannot forge a closing tag.
    assert.notInclude(turn.content, '</tool_result> world')
    assert.include(turn.content, 'tool-result')

    const big = buildToolResultTurn('c1', 'x'.repeat(1000), 50)
    assert.isAtMost(big.content.length, 50)
  })

  test('coerces undefined to empty and a non-serializable value to a safe placeholder', ({
    assert,
  }) => {
    assert.equal(buildToolResultTurn('c1', undefined, 100).content, '<tool_result></tool_result>')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.include(buildToolResultTurn('c1', circular, 100).content, 'not serializable')
  })
})

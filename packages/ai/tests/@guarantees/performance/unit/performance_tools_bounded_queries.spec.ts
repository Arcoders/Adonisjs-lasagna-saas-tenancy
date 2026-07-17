import { test } from '@japa/runner'
import ToolExecutorService from '../../../../src/services/tool_executor.js'
import { buildToolLoopProducer } from '../../../../src/gateway/tool_loop.js'
import { fakeTenant } from '../../../helpers/stream_doubles.js'
import { toolCallFragment } from '../../../helpers/tool_chat_doubles.js'
import MockAIProvider from '../../../../src/testing/mock_ai_provider.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { AIToolHostDefinition, AIToolsConfig } from '../../../../src/define_config.js'
import type { AiToolAuditEvent } from '../../../../src/gateway/audit_seam.js'
import type { AIStreamRequest, StreamFragment } from '../../../../src/types/ai_provider_contract.js'

/**
 * The tool path's own cost is CONSTANT per call, independent of what the handler
 * returns or how big the result is.
 *
 * This matters because a tool is the first place the satellite runs host code that
 * touches the tenant's database on a per-request path. If the executor's own
 * bookkeeping (audit, metrics) scaled with the result — one audit row per returned
 * row, say — a single "list my fleet" would fan out into an N+1 against the shared
 * backoffice audit table, which is the one table every tenant contends on. The
 * handler's own query cost is the host's business; the SATELLITE's overhead must be
 * O(1) per call and O(rounds) per request, never O(rows).
 */

const ctx = {} as unknown as HttpContext

/** A handler whose result size is controllable, so cost can be probed against it. */
function tool(rows: number): AIToolHostDefinition {
  return {
    name: 'list_rows',
    description: 'list rows',
    inputSchema: { type: 'object', properties: {} },
    mode: 'read',
    handler: async () => ({ rows: Array.from({ length: rows }, (_, i) => ({ i })) }),
  }
}

const toolsConfig: AIToolsConfig = { acknowledgeUnauthorizedTools: true }

/** An executor wired with recording audit + metric sinks. */
function recordingExecutor(fullSet: AIToolHostDefinition[]) {
  const audits: AiToolAuditEvent[] = []
  const metrics: { name: string; value: number }[] = []
  const service = new ToolExecutorService({
    runScoped: (_tenant, fn) => fn(),
    activeScopeTenantId: () => undefined,
    getToolsConfig: () => toolsConfig,
    toolAudit: {
      append: async (event) => {
        audits.push(event)
      },
    },
    emitMetric: (_tenantId, name, value) => {
      metrics.push({ name, value })
    },
  })
  return { audits, metrics, executor: service.forRequest(ctx, fakeTenant, fullSet, 'p-hash') }
}

async function drain(producer: (signal: AbortSignal) => AsyncIterable<StreamFragment>) {
  const out: StreamFragment[] = []
  for await (const fragment of producer(new AbortController().signal)) out.push(fragment)
  return out
}

test.group('performance — the tool path is O(1) per call', () => {
  test('one call writes exactly one audit row, whatever the result size', async ({ assert }) => {
    for (const rows of [0, 1, 50, 5_000]) {
      const { audits, executor } = recordingExecutor([tool(rows)])
      await executor.execute(
        { id: 'c1', name: 'list_rows', arguments: '{}' },
        new AbortController().signal,
        1
      )
      assert.lengthOf(audits, 1, `${rows} rows must still be exactly one audit append`)
    }
  })

  test('one call emits a fixed metric set, whatever the result size', async ({ assert }) => {
    const shapes: string[][] = []
    for (const rows of [0, 5_000]) {
      const { metrics, executor } = recordingExecutor([tool(rows)])
      await executor.execute(
        { id: 'c1', name: 'list_rows', arguments: '{}' },
        new AbortController().signal,
        1
      )
      shapes.push(metrics.map((m) => m.name).sort())
    }
    // The same names in the same number, regardless of payload: a completed call is
    // one `calls` + one `latency_ms`, never a per-row emission.
    assert.deepEqual(shapes[0], shapes[1], 'the metric set must not scale with the result')
    assert.lengthOf(shapes[0]!, 2)
  })

  test('a refused call costs one audit row and never runs the handler', async ({ assert }) => {
    // The denial path must not be cheaper to observe than the happy path — an
    // unaudited refusal is an invisible attack — nor more expensive.
    let ran = false
    const guarded: AIToolHostDefinition = {
      ...tool(1),
      handler: async () => {
        ran = true
        return {}
      },
    }
    const { audits, executor } = recordingExecutor([guarded])
    await assert.rejects(() =>
      executor.execute(
        { id: 'c1', name: 'no_such_tool', arguments: '{}' },
        new AbortController().signal,
        1
      )
    )
    assert.lengthOf(audits, 1)
    assert.equal(audits[0]!.outcome, 'denied')
    assert.isFalse(ran)
  })

  test('a loop makes exactly one provider call per round, no re-entrancy fan-out', async ({
    assert,
  }) => {
    // The loop re-enters the provider per round; a bug that re-entered per TOOL CALL
    // would multiply upstream spend silently. Two tools in round 1 must still be one
    // provider call for round 2.
    const rounds: StreamFragment[][] = [
      [toolCallFragment('c1', 'list_rows', '{}'), toolCallFragment('c2', 'list_rows', '{}')],
      [{ data: 'done', tokens: 1 }],
    ]
    const provider = new MockAIProvider({ name: 'claude', contractVersion: 2, rounds })
    const { audits, executor } = recordingExecutor([tool(3)])
    const baseRequest: AIStreamRequest = { messages: [{ role: 'user', content: 'hi' }] }

    await drain(
      buildToolLoopProducer({
        tenantId: fakeTenant.id,
        provider,
        baseRequest,
        tools: [{ name: 'list_rows', description: 'list rows', inputSchema: {} }],
        executor,
        perRoundMaxTokens: 100,
        maxRounds: 4,
      })
    )

    assert.lengthOf(provider.calls, 2, 'two rounds ⇒ two provider calls, not one per tool')
    assert.lengthOf(audits, 2, 'one audit row per executed tool call')
  })
})

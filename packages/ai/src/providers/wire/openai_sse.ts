import AIException from '../../exceptions/ai_exception.js'
import type { AIToolCall, StreamFragment } from '../../types/ai_provider_contract.js'
import { parseSseFrames } from './sse_frames.js'

/** A streamed tool call accumulating across its delta chunks, keyed by `index`. */
interface ToolCallAccumulator {
  id: string
  name: string
  args: string
}

/**
 * Parse an OpenAI-compatible chat-completions SSE byte stream (DeepSeek, Kimi,
 * and any OpenAI-compatible endpoint) into StreamFragments. Text arrives on
 * `choices[].delta.content`; the final `usage.completion_tokens` (when the caller
 * requested usage) is emitted as a `usage` fragment. Streamed
 * `choices[].delta.tool_calls[]` are accumulated by `index` and
 * emitted as one `tool_call` fragment per call when `finish_reason` is
 * `'tool_calls'`; a call that never received an id and name is discarded rather
 * than surfaced partial. The `data: [DONE]` sentinel ends the stream; an error
 * payload becomes a sanitized {@link AIException} (a classified code only, never
 * the upstream body); a malformed frame is skipped.
 */
export async function* parseOpenAiStream(
  source: AsyncIterable<Uint8Array>
): AsyncIterable<StreamFragment> {
  let reportedCompletionTokens = 0
  const toolCalls = new Map<number, ToolCallAccumulator>()

  for await (const frame of parseSseFrames(source)) {
    if (frame.data === '[DONE]') return

    const payload = tryParse(frame.data)
    if (payload === undefined) continue // malformed frame: skip, never crash

    if (payload.error !== undefined) {
      throw toOpenAiException(payload.error)
    }

    const content = readContent(payload)
    if (content) yield { data: content, tokens: 0 }

    accumulateToolCalls(toolCalls, payload)
    if (readFinishReason(payload) === 'tool_calls') {
      for (const call of finalizeToolCalls(toolCalls)) {
        yield { data: '', tokens: 0, event: 'tool_call', toolCall: call }
      }
      toolCalls.clear() // consumed: never re-emit a call
    }

    const completion = readCompletionTokens(payload)
    if (completion !== undefined && completion > reportedCompletionTokens) {
      yield { data: '', tokens: completion - reportedCompletionTokens, event: 'usage' }
      reportedCompletionTokens = completion
    }
  }
}

function tryParse(data: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(data)
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function readContent(payload: Record<string, unknown>): string | undefined {
  const choices = payload.choices as Array<{ delta?: { content?: unknown } }> | undefined
  const content = choices?.[0]?.delta?.content
  return typeof content === 'string' ? content : undefined
}

function readCompletionTokens(payload: Record<string, unknown>): number | undefined {
  const usage = payload.usage as { completion_tokens?: unknown } | null | undefined
  const tokens = usage?.completion_tokens
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined
}

function readFinishReason(payload: Record<string, unknown>): string | undefined {
  const choices = payload.choices as Array<{ finish_reason?: unknown }> | undefined
  const reason = choices?.[0]?.finish_reason
  return typeof reason === 'string' ? reason : undefined
}

/** Accumulate this frame's `delta.tool_calls[]` deltas by `index`; id and name arrive once, arguments stream. */
function accumulateToolCalls(
  calls: Map<number, ToolCallAccumulator>,
  payload: Record<string, unknown>
): void {
  const choices = payload.choices as Array<{ delta?: { tool_calls?: unknown } }> | undefined
  const deltas = choices?.[0]?.delta?.tool_calls
  if (!Array.isArray(deltas)) return
  for (const raw of deltas) {
    // A null / non-object array element is a malformed delta: skip it rather than
    // dereference it (matching the "a malformed frame is skipped" contract and the
    // Anthropic parser's `?.` house style), so a hostile upstream cannot crash the pump.
    if (raw === null || typeof raw !== 'object') continue
    const entry = raw as {
      index?: unknown
      id?: unknown
      function?: { name?: unknown; arguments?: unknown }
    }
    if (typeof entry.index !== 'number' || !Number.isInteger(entry.index)) continue
    const existing = calls.get(entry.index) ?? { id: '', name: '', args: '' }
    if (typeof entry.id === 'string' && entry.id.length > 0) existing.id = entry.id
    if (typeof entry.function?.name === 'string' && entry.function.name.length > 0) {
      existing.name = entry.function.name
    }
    if (typeof entry.function?.arguments === 'string') existing.args += entry.function.arguments
    calls.set(entry.index, existing)
  }
}

/** Fully-identified tool calls in index order, as {@link AIToolCall}s (arguments validated later). */
function finalizeToolCalls(calls: Map<number, ToolCallAccumulator>): AIToolCall[] {
  return [...calls.entries()]
    .filter(([, call]) => call.id.length > 0 && call.name.length > 0)
    .sort(([a], [b]) => a - b)
    .map(([, call]) => ({ id: call.id, name: call.name, arguments: call.args }))
}

/** Map an OpenAI-compatible error payload to a sanitized code, never echoing the body. */
function toOpenAiException(error: unknown): AIException {
  const detail = error as { code?: string; type?: string } | null
  const marker = detail?.code ?? detail?.type
  if (marker === 'rate_limit_exceeded' || marker === 'insufficient_quota') {
    return new AIException('rate_limited', 'provider rate limited')
  }
  return new AIException('provider_unavailable', 'provider stream error')
}

import AIException from '../../exceptions/ai_exception.js'
import type { AIToolCall, StreamFragment } from '../../types/ai_provider_contract.js'
import { parseSseFrames } from './sse_frames.js'

/** A `tool_use` content block accumulating across its streamed deltas, keyed by block `index`. */
interface ToolBlock {
  id: string
  name: string
  args: string
  complete: boolean
}

/**
 * Parse an Anthropic Messages SSE byte stream into StreamFragments. Text arrives
 * on `content_block_delta` (`delta.text`); cumulative output tokens arrive on
 * `message_delta` (`usage.output_tokens`), emitted as a `usage` fragment carrying
 * the incremental delta so the streaming service can settle real token counts. A
 * `tool_use` content block is accumulated across its `input_json_delta` chunks
 * (WS-AI-11) and emitted as one `tool_call` fragment per completed call when
 * `message_delta` reports `stop_reason: 'tool_use'`; a block that never reaches
 * `content_block_stop` is discarded rather than surfaced with partial arguments.
 * A round may carry both text and tool_use: the text streams live and the tool
 * calls follow at the stop. `message_stop` ends the stream; an `error` event
 * becomes a sanitized {@link AIException} (a classified code only, never the
 * upstream body); a malformed data frame is skipped rather than crashing the pump.
 */
export async function* parseAnthropicStream(
  source: AsyncIterable<Uint8Array>
): AsyncIterable<StreamFragment> {
  let reportedOutputTokens = 0
  const toolBlocks = new Map<number, ToolBlock>()

  for await (const frame of parseSseFrames(source)) {
    if (frame.event === 'message_stop' || frame.data === '[DONE]') return

    if (frame.event === 'error') {
      throw toAnthropicException(frame.data)
    }

    const payload = tryParse(frame.data)
    if (payload === undefined) continue // malformed frame: skip, never crash

    if (frame.event === 'content_block_start') {
      openToolBlock(toolBlocks, payload)
      continue
    }

    if (frame.event === 'content_block_delta') {
      const text = readText(payload)
      if (text) {
        yield { data: text, tokens: 0 }
      } else {
        appendToolArgs(toolBlocks, payload)
      }
      continue
    }

    if (frame.event === 'content_block_stop') {
      const block = toolBlocks.get(readIndex(payload) ?? -1)
      if (block) block.complete = true
      continue
    }

    if (frame.event === 'message_delta' || frame.event === 'message_start') {
      const output = readOutputTokens(payload)
      if (output !== undefined && output > reportedOutputTokens) {
        yield { data: '', tokens: output - reportedOutputTokens, event: 'usage' }
        reportedOutputTokens = output
      }
      if (frame.event === 'message_delta' && readStopReason(payload) === 'tool_use') {
        for (const call of finalizeToolCalls(toolBlocks)) {
          yield { data: '', tokens: 0, event: 'tool_call', toolCall: call }
        }
        toolBlocks.clear() // consumed: never re-emit a call
      }
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

function readText(payload: Record<string, unknown>): string | undefined {
  const delta = payload.delta as { type?: string; text?: string } | undefined
  return typeof delta?.text === 'string' ? delta.text : undefined
}

function readOutputTokens(payload: Record<string, unknown>): number | undefined {
  const usage =
    (payload.usage as { output_tokens?: unknown } | undefined) ??
    (payload.message as { usage?: { output_tokens?: unknown } } | undefined)?.usage ??
    undefined
  const tokens = usage?.output_tokens
  return typeof tokens === 'number' && Number.isFinite(tokens) ? tokens : undefined
}

/** The integer content-block index a frame addresses, or undefined if absent/malformed. */
function readIndex(payload: Record<string, unknown>): number | undefined {
  const index = payload.index
  return typeof index === 'number' && Number.isInteger(index) ? index : undefined
}

/** Open a tool_use accumulator on `content_block_start`, ignoring text blocks and malformed frames. */
function openToolBlock(blocks: Map<number, ToolBlock>, payload: Record<string, unknown>): void {
  const index = readIndex(payload)
  const block = payload.content_block as { type?: string; id?: unknown; name?: unknown } | undefined
  if (index === undefined || block?.type !== 'tool_use') return
  if (typeof block.id !== 'string' || typeof block.name !== 'string') return
  blocks.set(index, { id: block.id, name: block.name, args: '', complete: false })
}

/** Append an `input_json_delta` chunk to its accumulator; a text delta or unknown block is ignored. */
function appendToolArgs(blocks: Map<number, ToolBlock>, payload: Record<string, unknown>): void {
  const index = readIndex(payload)
  const delta = payload.delta as { type?: string; partial_json?: unknown } | undefined
  if (index === undefined || delta?.type !== 'input_json_delta') return
  if (typeof delta.partial_json !== 'string') return
  const block = blocks.get(index)
  if (block) block.args += delta.partial_json
}

function readStopReason(payload: Record<string, unknown>): string | undefined {
  const delta = payload.delta as { stop_reason?: unknown } | undefined
  return typeof delta?.stop_reason === 'string' ? delta.stop_reason : undefined
}

/** Completed tool_use blocks in index order, as {@link AIToolCall}s (arguments validated later). */
function finalizeToolCalls(blocks: Map<number, ToolBlock>): AIToolCall[] {
  return [...blocks.entries()]
    .filter(([, block]) => block.complete)
    .sort(([a], [b]) => a - b)
    .map(([, block]) => ({ id: block.id, name: block.name, arguments: block.args }))
}

/** Map an Anthropic error event to a sanitized code, never echoing the body. */
function toAnthropicException(data: string): AIException {
  const payload = tryParse(data)
  const type = (payload?.error as { type?: string } | undefined)?.type
  if (type === 'rate_limit_error') return new AIException('rate_limited', 'anthropic rate limited')
  if (type === 'overloaded_error') {
    return new AIException('provider_unavailable', 'anthropic overloaded')
  }
  return new AIException('provider_unavailable', 'anthropic stream error')
}

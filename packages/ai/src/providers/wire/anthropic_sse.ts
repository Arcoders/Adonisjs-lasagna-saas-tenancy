import AIException from '../../exceptions/ai_exception.js'
import type { StreamFragment } from '../../types/ai_provider_contract.js'
import { parseSseFrames } from './sse_frames.js'

/**
 * Parse an Anthropic Messages SSE byte stream into StreamFragments. Text arrives
 * on `content_block_delta` (`delta.text`); cumulative output tokens arrive on
 * `message_delta` (`usage.output_tokens`), emitted as a `usage` fragment carrying
 * the incremental delta so the streaming service can settle real token counts.
 * `message_stop` ends the stream; an `error` event becomes a sanitized
 * {@link AIException} (a classified code only, never the upstream body); a
 * malformed data frame is skipped rather than crashing the pump.
 */
export async function* parseAnthropicStream(
  source: AsyncIterable<Uint8Array>
): AsyncIterable<StreamFragment> {
  let reportedOutputTokens = 0

  for await (const frame of parseSseFrames(source)) {
    if (frame.event === 'message_stop' || frame.data === '[DONE]') return

    if (frame.event === 'error') {
      throw toAnthropicException(frame.data)
    }

    const payload = tryParse(frame.data)
    if (payload === undefined) continue // malformed frame: skip, never crash

    if (frame.event === 'content_block_delta') {
      const text = readText(payload)
      if (text) yield { data: text, tokens: 0 }
      continue
    }

    if (frame.event === 'message_delta' || frame.event === 'message_start') {
      const output = readOutputTokens(payload)
      if (output !== undefined && output > reportedOutputTokens) {
        yield { data: '', tokens: output - reportedOutputTokens, event: 'usage' }
        reportedOutputTokens = output
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

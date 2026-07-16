import AIException from '../../exceptions/ai_exception.js'
import type { StreamFragment } from '../../types/ai_provider_contract.js'
import { parseSseFrames } from './sse_frames.js'

/**
 * Parse an OpenAI-compatible chat-completions SSE byte stream (DeepSeek, Kimi,
 * and any OpenAI-compatible endpoint) into StreamFragments. Text arrives on
 * `choices[].delta.content`; the final `usage.completion_tokens` (when the caller
 * requested usage) is emitted as a `usage` fragment. The `data: [DONE]` sentinel
 * ends the stream; an error payload becomes a sanitized {@link AIException} (a
 * classified code only, never the upstream body); a malformed frame is skipped.
 */
export async function* parseOpenAiStream(
  source: AsyncIterable<Uint8Array>
): AsyncIterable<StreamFragment> {
  let reportedCompletionTokens = 0

  for await (const frame of parseSseFrames(source)) {
    if (frame.data === '[DONE]') return

    const payload = tryParse(frame.data)
    if (payload === undefined) continue // malformed frame: skip, never crash

    if (payload.error !== undefined) {
      throw toOpenAiException(payload.error)
    }

    const content = readContent(payload)
    if (content) yield { data: content, tokens: 0 }

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

/** Map an OpenAI-compatible error payload to a sanitized code, never echoing the body. */
function toOpenAiException(error: unknown): AIException {
  const detail = error as { code?: string; type?: string } | null
  const marker = detail?.code ?? detail?.type
  if (marker === 'rate_limit_exceeded' || marker === 'insufficient_quota') {
    return new AIException('rate_limited', 'provider rate limited')
  }
  return new AIException('provider_unavailable', 'provider stream error')
}

/** One parsed SSE frame: its event name (default `message`) and joined data. */
export interface SseFrame {
  readonly event: string
  readonly data: string
}

/**
 * Split a byte stream into SSE frames, correctly reassembling a frame that is
 * split across chunk boundaries (the load-bearing property of a streaming
 * parser). Comment lines (`:` heartbeats) are dropped; a frame with no `data:`
 * line is skipped. CRLF and LF line endings are both handled. This is the only
 * place SSE framing lives; each vendor dialect interprets the frames.
 */
export async function* parseSseFrames(source: AsyncIterable<Uint8Array>): AsyncIterable<SseFrame> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of source) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n')
    let boundary: number
    while ((boundary = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      const frame = parseFrame(raw)
      if (frame) yield frame
    }
  }

  // Flush a trailing frame that arrived without its terminating blank line.
  const tail = (buffer + decoder.decode()).replace(/\r\n/g, '\n').trim()
  if (tail) {
    const frame = parseFrame(tail)
    if (frame) yield frame
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message'
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0 || line.startsWith(':')) continue // blank or comment/heartbeat
    if (line.startsWith('event:')) {
      event = line.slice('event:'.length).trim()
    } else if (line.startsWith('data:')) {
      // A single leading space after the colon is stripped, per the SSE spec.
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
  }
  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

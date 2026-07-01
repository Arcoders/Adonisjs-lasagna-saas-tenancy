import type { StreamFragment } from '../../src/types/ai_provider_contract.js'

/** Build an async byte source from string chunks, so a test controls frame splitting. */
export function byteSource(...chunks: string[]): AsyncIterable<Uint8Array> {
  const encoder = new TextEncoder()
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk)
  })()
}

/** Drain a fragment stream into an array. */
export async function collect(iter: AsyncIterable<StreamFragment>): Promise<StreamFragment[]> {
  const out: StreamFragment[] = []
  for await (const fragment of iter) out.push(fragment)
  return out
}

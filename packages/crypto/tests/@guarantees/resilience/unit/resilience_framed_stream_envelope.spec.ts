import { test } from '@japa/runner'
import { randomBytes } from 'node:crypto'
import {
  sealFramedV2,
  openFramedV2,
  sealFramedV2Stream,
  openFramedV2Stream,
} from '../../../../src/internal/framed_stream.js'
import { FRAMED_STREAM_PREFIX } from '../../../../src/types/framed_envelope.js'

const DEK = randomBytes(32)
const OTHER_DEK = randomBytes(32)
const BASE = 'wrapped-dek-row-0001'
const FRAME = 16 // tiny frames so a small payload spans several

/** Split a single-shot envelope into its frames (drop the container prefix). */
function framesOf(envelope: string): string[] {
  return envelope.slice(FRAMED_STREAM_PREFIX.length).split('\n')
}
/** Rebuild an envelope from (manipulated) frames. */
function envelopeOf(frames: string[]): string {
  return FRAMED_STREAM_PREFIX + frames.join('\n')
}
async function* streamOf(chunks: Buffer[]): AsyncIterable<Buffer> {
  for (const c of chunks) yield c
}
async function collect(frames: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = []
  for await (const f of frames) out.push(f)
  return out
}
async function drain(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const out: Buffer[] = []
  for await (const c of chunks) out.push(c)
  return Buffer.concat(out)
}

// crypto §6.8 / I1: the framed enc_v2 stream envelope is a COMPOSITION of core's GCM
// primitive per frame (not a new cipher), with a monotonic frame counter bound into the
// authenticated keyId and a terminator carrying the frame count. Every integrity fault —
// reorder, drop, duplicate, truncation, tamper, wrong DEK, cross-stream splice — must
// fail closed; a healthy payload round-trips byte-for-byte.
test.group('crypto framed enc_v2 stream envelope (§6.8) — integrity is fail-closed', () => {
  test('round-trips a multi-frame payload byte-for-byte', ({ assert }) => {
    const data = randomBytes(FRAME * 5 + 7) // several full frames + a short tail
    const sealed = sealFramedV2(data, DEK, BASE, { frameSize: FRAME })
    assert.isTrue(sealed.startsWith(FRAMED_STREAM_PREFIX))
    assert.isAbove(framesOf(sealed).length, 5) // > 5 data frames + terminator
    assert.isTrue(openFramedV2(sealed, DEK).equals(data))
  })

  test('round-trips an empty payload and an exact frame multiple', ({ assert }) => {
    for (const data of [Buffer.alloc(0), randomBytes(FRAME * 3)]) {
      const sealed = sealFramedV2(data, DEK, BASE, { frameSize: FRAME })
      assert.isTrue(openFramedV2(sealed, DEK).equals(data))
    }
  })

  test('reorder: swapping two frames fails closed', ({ assert }) => {
    const frames = framesOf(sealFramedV2(randomBytes(FRAME * 4), DEK, BASE, { frameSize: FRAME }))
    ;[frames[0], frames[1]] = [frames[1]!, frames[0]!]
    assert.throws(() => openFramedV2(envelopeOf(frames), DEK), /out-of-order|different stream/)
  })

  test('drop: removing a middle frame fails closed', ({ assert }) => {
    const frames = framesOf(sealFramedV2(randomBytes(FRAME * 4), DEK, BASE, { frameSize: FRAME }))
    frames.splice(1, 1)
    assert.throws(() => openFramedV2(envelopeOf(frames), DEK), /out-of-order|terminator|frames/)
  })

  test('duplicate: repeating a frame fails closed', ({ assert }) => {
    const frames = framesOf(sealFramedV2(randomBytes(FRAME * 4), DEK, BASE, { frameSize: FRAME }))
    frames.splice(1, 0, frames[1]!) // re-insert frame #1
    assert.throws(() => openFramedV2(envelopeOf(frames), DEK), /out-of-order|frames/)
  })

  test('truncate: cutting before the terminator fails closed', ({ assert }) => {
    const frames = framesOf(sealFramedV2(randomBytes(FRAME * 4), DEK, BASE, { frameSize: FRAME }))
    frames.pop() // drop the terminator
    assert.throws(() => openFramedV2(envelopeOf(frames), DEK), /truncated|terminator/)
  })

  test('tamper: flipping a byte in a frame fails the GCM tag', ({ assert }) => {
    const frames = framesOf(sealFramedV2(randomBytes(FRAME * 3), DEK, BASE, { frameSize: FRAME }))
    const f = frames[1]!
    // Flip the last hex char of the cipher segment.
    const last = f.slice(-1)
    frames[1] = f.slice(0, -1) + (last === 'a' ? 'b' : 'a')
    assert.throws(() => openFramedV2(envelopeOf(frames), DEK))
  })

  test('wrong DEK never yields plaintext', ({ assert }) => {
    const sealed = sealFramedV2(randomBytes(FRAME * 3), DEK, BASE, { frameSize: FRAME })
    assert.throws(() => openFramedV2(sealed, OTHER_DEK))
  })

  test('cross-stream: splicing a frame from another envelope fails closed', ({ assert }) => {
    const a = framesOf(sealFramedV2(randomBytes(FRAME * 3), DEK, BASE, { frameSize: FRAME }))
    const b = framesOf(
      sealFramedV2(randomBytes(FRAME * 3), DEK, 'other-base', { frameSize: FRAME })
    )
    a[1] = b[1]! // a valid frame, but from a different base
    assert.throws(() => openFramedV2(envelopeOf(a), DEK), /different stream|out-of-order/)
  })

  test('rejects a base keyId containing a reserved character', ({ assert }) => {
    assert.throws(() => sealFramedV2(randomBytes(4), DEK, 'has:colon', { frameSize: FRAME }))
    assert.throws(() => sealFramedV2(randomBytes(4), DEK, 'has#marker', { frameSize: FRAME }))
  })

  test('streaming seal/open round-trips across arbitrary chunk boundaries', async ({ assert }) => {
    const data = randomBytes(FRAME * 4 + 5)
    // Feed the source in oddly-sized parts to exercise the re-chunker.
    const parts = [
      data.subarray(0, 3),
      data.subarray(3, FRAME * 2 + 1),
      data.subarray(FRAME * 2 + 1),
    ]
    const frames = await collect(
      sealFramedV2Stream(streamOf(parts), DEK, BASE, { frameSize: FRAME })
    )
    const round = await drain(openFramedV2Stream(arrayStream(frames), DEK))
    assert.isTrue(round.equals(data))
  })

  test('streaming open fails closed on a truncated frame sequence', async ({ assert }) => {
    const data = randomBytes(FRAME * 3)
    const frames = await collect(
      sealFramedV2Stream(streamOf([data]), DEK, BASE, { frameSize: FRAME })
    )
    frames.pop() // drop the terminator
    await assert.rejects(
      () => drain(openFramedV2Stream(arrayStream(frames), DEK)),
      /truncated|terminator/
    )
  })
})

/** Yield the given frame strings as an async iterable (a stored/streamed frame sequence). */
async function* arrayStream(frames: string[]): AsyncIterable<string> {
  for (const f of frames) yield f
}

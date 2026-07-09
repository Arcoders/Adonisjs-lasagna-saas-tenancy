import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'
import CryptoException from '../exceptions/crypto_exception.js'
import {
  DEFAULT_FRAME_SIZE,
  FRAMED_STREAM_PREFIX,
  type FramedSealOptions,
} from '../types/framed_envelope.js'

/**
 * The framed enc_v2 stream envelope (§6.8): a COMPOSITION of core's `sealV2WithKey` /
 * `openV2WithKey` per frame, NOT a new cipher (I1). Each frame's non-secret enc_v2
 * `keyId` is `` `${baseKeyId}#${index}` `` (a monotonic counter), and core binds that
 * `keyId` into the GCM header-as-AAD, so a reordered / dropped / duplicated /
 * cross-stream frame fails to line up (or fails authentication). A final terminator
 * frame (`` `${baseKeyId}#$` ``) seals the authenticated frame COUNT, so a truncated
 * stream — the terminator missing, or a short count — is detected, never silently
 * accepted as complete.
 *
 * The opener never needs `baseKeyId`: it derives the base from the first frame and
 * enforces every subsequent frame shares it, so a frame spliced in from a different
 * stream (a different base) is rejected too.
 */

// core's enc_v2 frame prefix (`enc_v2:<keyId>:<iv>:<tag>:<cipher>`), frozen. The frame
// index rides the `keyId` segment, which core authenticates as GCM AAD.
const ENC_V2_PREFIX = 'enc_v2:'
// Delimiter between the base keyId and the frame counter. Never a colon (that would
// split the enc_v2 envelope); `#` is safe and forbidden in a base keyId below.
const FRAME_MARKER = '#'
// The terminator's counter suffix. It seals the total data-frame count as its plaintext.
const TERMINATOR_SUFFIX = '$'

function invalid(reason: string): CryptoException {
  return new CryptoException('framed_stream_invalid', `[crypto] framed stream envelope: ${reason}`)
}

/** A base keyId must be usable as an enc_v2 keyId AND leave the frame marker unambiguous. */
function assertBaseKeyId(baseKeyId: string): void {
  if (baseKeyId.includes(':')) {
    throw invalid("baseKeyId must not contain ':' (it would break the enc_v2 frame).")
  }
  if (baseKeyId.includes(FRAME_MARKER)) {
    throw invalid(`baseKeyId must not contain '${FRAME_MARKER}' (the frame-counter marker).`)
  }
  if (baseKeyId.length === 0) throw invalid('baseKeyId must be non-empty.')
}

function frameKeyId(baseKeyId: string, suffix: string): string {
  return `${baseKeyId}${FRAME_MARKER}${suffix}`
}

/** Parse a frame's authenticated `keyId` back into its base and counter suffix. */
function parseFrameKeyId(frame: string): { base: string; suffix: string } {
  if (!frame.startsWith(ENC_V2_PREFIX)) throw invalid('a frame is not an enc_v2 envelope.')
  const keyId = frame.slice(ENC_V2_PREFIX.length).split(':')[0] ?? ''
  const at = keyId.lastIndexOf(FRAME_MARKER)
  if (at < 0) throw invalid("a frame's keyId is missing the frame-counter marker.")
  return { base: keyId.slice(0, at), suffix: keyId.slice(at + 1) }
}

/**
 * Validates a frame sequence one frame at a time (shared by the single-shot and the
 * streaming openers): enforces a constant base, a strictly increasing 0-based counter,
 * exactly one trailing terminator, and the authenticated frame count. Every frame is
 * strict-opened, so a tamper fails the GCM tag.
 */
class FrameSequenceReader {
  #base: string | null = null
  #expected = 0
  #done = false

  /** Consume one frame; returns its decrypted bytes, or `null` for the terminator. */
  next(frame: string, dek: Buffer): Buffer | null {
    if (this.#done) throw invalid('a frame follows the terminator (trailing data).')

    const { base, suffix } = parseFrameKeyId(frame)
    if (this.#base === null) this.#base = base
    else if (base !== this.#base)
      throw invalid('a frame belongs to a different stream (base mismatch).')

    if (suffix === TERMINATOR_SUFFIX) {
      const declared = Number(openV2WithKey(frame, dek))
      if (!Number.isInteger(declared) || declared !== this.#expected) {
        throw invalid(
          `truncated: terminator declares ${declared} frames but ${this.#expected} were read.`
        )
      }
      this.#done = true
      return null
    }

    const index = Number(suffix)
    if (!Number.isInteger(index) || index < 0)
      throw invalid(`a frame has a non-index counter '${suffix}'.`)
    if (index !== this.#expected) {
      throw invalid(
        `out-of-order / dropped / duplicate frame: expected ${this.#expected}, got ${index}.`
      )
    }
    this.#expected++
    return Buffer.from(openV2WithKey(frame, dek), 'base64')
  }

  /** Assert the stream ended on a terminator (else it was truncated before completion). */
  finish(): void {
    if (!this.#done) throw invalid('truncated: the terminator frame is missing.')
  }
}

/** Split a buffer into fixed-size chunks (the last may be shorter). */
function* chunk(data: Buffer, size: number): Generator<Buffer> {
  for (let offset = 0; offset < data.length; offset += size) {
    yield data.subarray(offset, offset + size)
  }
}

function frameSizeOf(options?: FramedSealOptions): number {
  const size = options?.frameSize
  if (size === undefined) return DEFAULT_FRAME_SIZE
  if (!Number.isInteger(size) || size <= 0) throw invalid('frameSize must be a positive integer.')
  return size
}

/**
 * Seal a buffer as a single-shot framed enc_v2 envelope string (the container form:
 * {@link FRAMED_STREAM_PREFIX} + `\n`-joined frames). O(payload) but whole-buffer; for
 * multi-GB blobs use {@link sealFramedV2Stream}.
 */
export function sealFramedV2(
  plaintext: Buffer,
  dek: Buffer,
  baseKeyId: string,
  options?: FramedSealOptions
): string {
  assertBaseKeyId(baseKeyId)
  const size = frameSizeOf(options)
  const frames: string[] = []
  let count = 0
  for (const part of chunk(plaintext, size)) {
    frames.push(sealV2WithKey(part.toString('base64'), dek, frameKeyId(baseKeyId, String(count))))
    count++
  }
  // Terminator seals the authenticated frame count so truncation is always detected.
  frames.push(sealV2WithKey(String(count), dek, frameKeyId(baseKeyId, TERMINATOR_SUFFIX)))
  return FRAMED_STREAM_PREFIX + frames.join('\n')
}

/**
 * Strict-open a single-shot framed envelope back to the original buffer. Throws
 * `framed_stream_invalid` on a reordered / dropped / duplicated / cross-stream /
 * truncated envelope, and (via the per-frame GCM tag) on a tampered frame or a wrong
 * DEK. Never returns partial plaintext (fail-closed, I3/I6).
 */
export function openFramedV2(envelope: string, dek: Buffer): Buffer {
  if (!envelope.startsWith(FRAMED_STREAM_PREFIX)) {
    throw invalid('not a framed enc_v2 envelope (missing container prefix).')
  }
  const body = envelope.slice(FRAMED_STREAM_PREFIX.length)
  if (body.length === 0) throw invalid('empty envelope (no frames).')
  const frames = body.split('\n')
  const reader = new FrameSequenceReader()
  const out: Buffer[] = []
  for (const frame of frames) {
    const bytes = reader.next(frame, dek)
    if (bytes !== null) out.push(bytes)
  }
  reader.finish()
  return Buffer.concat(out)
}

/**
 * Streaming seal (the §6.8 use case: `vault` encrypts a multi-GB blob before upload).
 * Re-chunks the source into fixed-size frames and yields each sealed frame string, then
 * a terminator. The consumer persists frames in order (e.g. one object part each); the
 * container prefix / newline joining is the single-shot form's concern, not this one.
 */
export async function* sealFramedV2Stream(
  source: AsyncIterable<Buffer>,
  dek: Buffer,
  baseKeyId: string,
  options?: FramedSealOptions
): AsyncIterable<string> {
  assertBaseKeyId(baseKeyId)
  const size = frameSizeOf(options)
  let count = 0
  let carry: Buffer = Buffer.alloc(0)
  for await (const part of source) {
    carry = carry.length === 0 ? part : Buffer.concat([carry, part])
    while (carry.length >= size) {
      const frame = carry.subarray(0, size)
      carry = carry.subarray(size)
      yield sealV2WithKey(frame.toString('base64'), dek, frameKeyId(baseKeyId, String(count)))
      count++
    }
  }
  if (carry.length > 0) {
    yield sealV2WithKey(carry.toString('base64'), dek, frameKeyId(baseKeyId, String(count)))
    count++
  }
  yield sealV2WithKey(String(count), dek, frameKeyId(baseKeyId, TERMINATOR_SUFFIX))
}

/**
 * Streaming strict-open: consumes framed enc_v2 frames in order and yields each
 * decrypted chunk. Applies the same fail-closed integrity checks as
 * {@link openFramedV2} (reorder / drop / duplicate / cross-stream / truncation via the
 * counted terminator, tamper via the per-frame GCM tag).
 */
export async function* openFramedV2Stream(
  frames: AsyncIterable<string>,
  dek: Buffer
): AsyncIterable<Buffer> {
  const reader = new FrameSequenceReader()
  for await (const frame of frames) {
    const bytes = reader.next(frame, dek)
    if (bytes !== null) yield bytes
  }
  reader.finish()
}

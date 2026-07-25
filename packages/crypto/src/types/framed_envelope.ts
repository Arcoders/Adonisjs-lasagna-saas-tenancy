/**
 * The framed enc_v2 stream envelope. A large blob cannot be sealed as a single GCM
 * tag: the tag is unverifiable until the last byte, so a multi-GB payload cannot
 * stream, and inventing a second chunked AEAD is exactly what the foundation
 * forbids. So crypto owns a composition of core's existing enc_v2 GCM primitive.
 * The payload is split into fixed-size frames, each sealed as an independent
 * `sealV2WithKey` under the SAME DEK, with a monotonic frame counter bound into the
 * authenticated header (the enc_v2 `keyId`, which core feeds to GCM as AAD) so a
 * reordered, dropped, duplicated, or cross-stream frame fails authentication. A
 * final terminator frame carries the authenticated frame count so a truncated
 * stream is detected rather than silently accepted. There is one AEAD and it is
 * core's. This is that primitive applied per frame with reorder and truncation
 * binding, NOT a new cipher.
 *
 * `vault` composes this to encrypt blobs before upload; it does not scope its own
 * envelope.
 */

/**
 * The container prefix for the single-shot string form ({@link sealFramedV2}). It is
 * versioned so the frame format is identifiable and can evolve without ambiguity;
 * changing the layout is an `encf_v2`-grade break, exactly as `enc_v2` versions core's
 * envelope. Frames inside the container are `\n`-joined (an enc_v2 frame is
 * colon/hex/base64 and never contains a newline).
 */
export const FRAMED_STREAM_PREFIX = 'encf_v1:' as const

/** The default frame size (64 KiB): large enough to amortize the per-frame GCM tag, small enough to stream. */
export const DEFAULT_FRAME_SIZE = 64 * 1024

/** Options for the framed seal. */
export interface FramedSealOptions {
  /**
   * The plaintext frame size in bytes (default {@link DEFAULT_FRAME_SIZE}). Frozen per
   * envelope: it does not need to be recorded (the opener re-derives frame boundaries
   * from the authenticated per-frame counter), but a host that changes it re-frames new
   * writes only; existing envelopes keep opening under their own framing.
   */
  readonly frameSize?: number
}

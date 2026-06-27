import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const V1_PREFIX = 'enc_v1:'
const V2_PREFIX = 'enc_v2:'

/**
 * Envelope versions are append-only. `enc_v1` is the legacy format
 * (`enc_v1:<iv>:<tag>:<cipher>`, key = `sha256(APP_KEY)`); we still READ it but
 * never write it. `enc_v2` is the current format
 * (`enc_v2:<keyId>:<iv>:<tag>:<cipher>`):
 *
 *  - The data key is derived with HKDF-SHA256 from APP_KEY (not a bare hash),
 *    with a fixed domain-separation salt and a per-secret-class `context` as the
 *    HKDF info, so two secret classes never share a key.
 *  - `keyId` is a short, non-secret HKDF tag of APP_KEY. It lets a rotation tool
 *    tell which key wrote a value and lets decrypt reject a wrong-key value with
 *    a clear error instead of an opaque auth-tag failure.
 *  - The header (`enc_v2:<keyId>:<iv>`) is fed to GCM as AAD, so tampering the
 *    version, key id, or IV fails the auth tag.
 *
 * These constants and the format are FROZEN for 1.0: changing any of them means
 * a new `enc_v3`, never an in-place edit, or every stored value becomes
 * unreadable.
 */
const HKDF_HASH = 'sha256'
const KEY_SALT = Buffer.from('lasagna:secret-at-rest:v2:key')
const KEY_ID_SALT = Buffer.from('lasagna:secret-at-rest:v2:key-id')
const KEY_ID_INFO = Buffer.from('key-id')
const KEY_ID_BYTES = 8
const DEFAULT_CONTEXT = 'lasagna:secret-at-rest:v2'

function requireAppKey(): string {
  const appKey = process.env.APP_KEY
  if (!appKey) throw new Error('APP_KEY environment variable is not set')
  return appKey
}

/** Legacy v1 key derivation: a bare SHA-256 of APP_KEY. Read-only. */
function v1Key(appKey: string): Buffer {
  return createHash('sha256').update(appKey).digest()
}

/** v2 data key: HKDF-SHA256(APP_KEY, KEY_SALT, info=context) -> 32 bytes. */
function v2Key(appKey: string, context: string): Buffer {
  return Buffer.from(
    hkdfSync(HKDF_HASH, Buffer.from(appKey, 'utf8'), KEY_SALT, Buffer.from(context, 'utf8'), 32)
  )
}

/** Non-secret identifier of an APP_KEY, stable across calls. */
function v2KeyId(appKey: string): string {
  return Buffer.from(
    hkdfSync(HKDF_HASH, Buffer.from(appKey, 'utf8'), KEY_ID_SALT, KEY_ID_INFO, KEY_ID_BYTES)
  ).toString('hex')
}

function encryptV2(plaintext: string, appKey: string, context: string): string {
  const key = v2Key(appKey, context)
  const keyId = v2KeyId(appKey)
  const iv = randomBytes(IV_BYTES)
  const header = `${V2_PREFIX}${keyId}:${iv.toString('hex')}`
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(header, 'utf8'))
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${header}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

function decryptV2(value: string, appKey: string, context: string): string {
  const parts = value.slice(V2_PREFIX.length).split(':')
  if (parts.length !== 4) throw new Error('Invalid encrypted value format')
  const [keyId, ivHex, tagHex, cipherHex] = parts

  // Constant-time key-id check: a mismatch means the value was written under a
  // different APP_KEY (a rotation), which we surface explicitly so callers can
  // route it through the rotation path instead of seeing an opaque GCM failure.
  const got = Buffer.from(keyId, 'hex')
  const want = Buffer.from(v2KeyId(appKey), 'hex')
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    throw new Error('decrypt: value was encrypted under a different APP_KEY (key id mismatch)')
  }

  const key = v2Key(appKey, context)
  const iv = Buffer.from(ivHex, 'hex')
  const header = `${V2_PREFIX}${keyId}:${ivHex}`
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAAD(Buffer.from(header, 'utf8'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(cipherHex, 'hex')) + decipher.final('utf8')
}

function decryptV1(value: string, key: Buffer): string {
  const parts = value.slice(V1_PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted value format')
  const [ivHex, tagHex, cipherHex] = parts
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivHex, 'hex'))
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'))
  return decipher.update(Buffer.from(cipherHex, 'hex')) + decipher.final('utf8')
}

/**
 * Encrypt a string into an `enc_v2` envelope using the process `APP_KEY`. Pass a
 * `context` to bind the value to a secret class (a different context derives a
 * different key); decrypt with the SAME context. Defaults to the standard
 * secret-at-rest context so the common `encrypt`/`decrypt` pair round-trips
 * without callers thinking about it.
 */
export function encrypt(plaintext: string, context: string = DEFAULT_CONTEXT): string {
  return encryptV2(plaintext, requireAppKey(), context)
}

/**
 * Decrypt an `enc_v2` or `enc_v1` value. A value WITHOUT a known prefix is
 * returned unchanged — a deliberate migration affordance so rows written before
 * encryption was added keep working. The flip side: a corrupted stored
 * ciphertext that lost its prefix would silently be treated as plaintext. Use
 * {@link decryptStrict} where the value MUST be ciphertext.
 *
 * Rotating `APP_KEY` makes every stored secret undecryptable until re-encrypted
 * (an `enc_v2` value reports a clear key-id mismatch) — run
 * `node ace tenant:secrets:reencrypt` with `OLD_APP_KEY` set as part of any
 * rotation (see the security guide).
 */
export function decrypt(value: string, context: string = DEFAULT_CONTEXT): string {
  if (value.startsWith(V2_PREFIX)) return decryptV2(value, requireAppKey(), context)
  if (value.startsWith(V1_PREFIX)) return decryptV1(value, v1Key(requireAppKey()))
  return value
}

/**
 * Like {@link decrypt}, but REJECTS a value that carries no known ciphertext
 * prefix instead of passing it through. For call sites where the stored value is
 * always written through {@link encrypt}, so a non-prefixed value can only mean
 * corruption or tampering.
 */
export function decryptStrict(value: string, context: string = DEFAULT_CONTEXT): string {
  if (value.startsWith(V2_PREFIX)) return decryptV2(value, requireAppKey(), context)
  if (value.startsWith(V1_PREFIX)) return decryptV1(value, v1Key(requireAppKey()))
  throw new Error('decryptStrict: value is not enc_v1/enc_v2 ciphertext')
}

/**
 * Decrypt with an explicit key instead of the process `APP_KEY`. Exists for key
 * rotation (`tenant:secrets:reencrypt` decrypts with the OLD key and re-encrypts
 * with the current one); not a general-purpose entry point. Throws when the
 * value is not `enc_v1`/`enc_v2` ciphertext.
 */
export function decryptWithAppKey(
  value: string,
  appKey: string,
  context: string = DEFAULT_CONTEXT
): string {
  if (value.startsWith(V2_PREFIX)) return decryptV2(value, appKey, context)
  if (value.startsWith(V1_PREFIX)) return decryptV1(value, v1Key(appKey))
  throw new Error('decryptWithAppKey: value is not enc_v1/enc_v2 ciphertext')
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(V1_PREFIX) || value.startsWith(V2_PREFIX)
}

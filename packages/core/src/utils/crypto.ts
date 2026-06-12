import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const PREFIX = 'enc_v1:'

function keyFrom(appKey: string): Buffer {
  return createHash('sha256').update(appKey).digest()
}

function getKey(): Buffer {
  const appKey = process.env.APP_KEY
  if (!appKey) throw new Error('APP_KEY environment variable is not set')
  return keyFrom(appKey)
}

export function encrypt(plaintext: string): string {
  const key = getKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  return `${PREFIX}${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`
}

/**
 * Decrypt an `enc_v1:` value. A value WITHOUT the prefix is returned unchanged —
 * a deliberate migration affordance so rows written before encryption was added
 * keep working. The flip side: a corrupted stored ciphertext that lost its
 * prefix would silently be treated as plaintext. Use {@link decryptStrict} in
 * contexts where the value MUST be ciphertext.
 *
 * The key is `sha256(APP_KEY)`: rotating `APP_KEY` makes every stored secret
 * undecryptable until re-encrypted — run `node ace tenant:secrets:reencrypt`
 * with `OLD_APP_KEY` set as part of any rotation (see the security guide).
 */
export function decrypt(value: string): string {
  if (!value.startsWith(PREFIX)) return value
  return decryptParsed(value, getKey())
}

/**
 * Like {@link decrypt}, but REJECTS a value that does not carry the `enc_v1:`
 * prefix instead of passing it through. For call sites where the stored value
 * is always written through {@link encrypt} (no plaintext-era rows), so a
 * non-prefixed value can only mean corruption or tampering.
 */
export function decryptStrict(value: string): string {
  if (!value.startsWith(PREFIX)) {
    throw new Error('decryptStrict: value is not enc_v1 ciphertext')
  }
  return decryptParsed(value, getKey())
}

/**
 * Decrypt with an explicit key instead of the process `APP_KEY`. Exists for
 * key rotation (`tenant:secrets:reencrypt` decrypts with the OLD key and
 * re-encrypts with the current one); not a general-purpose entry point.
 * Throws when the value is not `enc_v1:` ciphertext.
 */
export function decryptWithAppKey(value: string, appKey: string): string {
  if (!value.startsWith(PREFIX)) {
    throw new Error('decryptWithAppKey: value is not enc_v1 ciphertext')
  }
  return decryptParsed(value, keyFrom(appKey))
}

function decryptParsed(value: string, key: Buffer): string {
  const parts = value.slice(PREFIX.length).split(':')
  if (parts.length !== 3) throw new Error('Invalid encrypted value format')
  const [ivHex, tagHex, cipherHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(tagHex, 'hex')
  const ciphertext = Buffer.from(cipherHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX)
}

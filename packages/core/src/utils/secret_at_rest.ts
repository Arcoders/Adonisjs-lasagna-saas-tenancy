import { encrypt, decryptStrict } from './crypto.js'

/**
 * The single canonical seam for reading and writing tenant secrets at rest.
 *
 * Two properties every secret-bearing column gets for free by routing through
 * here, instead of each call site choosing for itself:
 *
 *  - FAIL CLOSED. Reads always use {@link decryptStrict}, so a value that is not
 *    `enc_v1`/`enc_v2` ciphertext (plaintext, corruption, tampering) throws
 *    rather than being silently treated as a usable secret. The lenient
 *    {@link import('./crypto.js').decrypt} is reserved for the bounded migration
 *    commands only.
 *  - DOMAIN SEPARATED. Each secret class encrypts under its own crypto context,
 *    so the HKDF-derived data keys never overlap. A ciphertext written for one
 *    class cannot be decrypted as another (confused-deputy resistance), and a
 *    future secret class is isolated from every existing one.
 *
 * Adding a secret is a two-line change: a `SECRET_CLASS` entry (its context) and,
 * if it lives in a backoffice column the rotation tool should cover, a
 * `SECRET_AT_REST_COLUMNS` entry. The anti-drift guard
 * (`@architecture/boundaries/no_lenient_decrypt_on_secrets.spec.ts`) keeps every
 * other module from calling `encrypt`/`decrypt` on a secret directly.
 */
export const SECRET_CLASS = {
  ssoClientSecret: 'sso:client_secret:v2',
  webhookSecret: 'webhook:secret:v2',
  // AI conversation memory (WS-AI-4, I2). Its own context so the HKDF data key
  // never overlaps another secret class. Deliberately NOT in SECRET_AT_REST_COLUMNS:
  // memory lives in Redis under a TTL, not a backoffice column, so it rotates via
  // the enc_v2 keyId dual-key read (OLD_APP_KEY grace window), never the column walker.
  aiConversationMemory: 'ai:conversation-memory:v1',
} as const

export type SecretClass = keyof typeof SECRET_CLASS

/**
 * The backoffice columns that hold an at-rest secret, each tagged with its class.
 * `tenant:secrets:reencrypt` derives its work list from this, so a new secret
 * column is covered by the rotation/migration tool the moment it is added here.
 */
export const SECRET_AT_REST_COLUMNS: ReadonlyArray<{
  table: string
  column: string
  cls: SecretClass
}> = [
  { table: 'tenant_webhooks', column: 'secret', cls: 'webhookSecret' },
  { table: 'tenant_sso_configs', column: 'client_secret', cls: 'ssoClientSecret' },
]

/** Encrypt a plaintext secret for storage under its class context. */
export function writeSecret(plain: string, cls: SecretClass): string {
  return encrypt(plain, SECRET_CLASS[cls])
}

/**
 * Decrypt a stored secret. Throws if the value is not ciphertext for this class
 * (plaintext, corruption, tampering, or a different secret class). Callers treat
 * the throw as a fail-closed read.
 */
export function readSecret(value: string, cls: SecretClass): string {
  return decryptStrict(value, SECRET_CLASS[cls])
}

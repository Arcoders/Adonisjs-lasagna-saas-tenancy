import { hkdfSync } from 'node:crypto'
import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'
import { DEK_BYTES } from '../constants.js'
import CryptoException from '../exceptions/crypto_exception.js'
import type { KeyProvider, WrappedDek } from '../types/key_provider.js'

// Domain-separation salts for the env KEK derivation. Distinct from core's
// secret-at-rest salts so the KEK is never the same bytes as an APP_KEY-derived
// data key. Frozen: changing them re-derives every KEK and bricks stored wraps.
const KEK_SALT = Buffer.from('lasagna:crypto:kek:v1')
const KEK_ID_SALT = Buffer.from('lasagna:crypto:kek-id:v1')
const KEK_ID_INFO = Buffer.from('kek-id')
const KEK_ID_BYTES = 8

function requireAppKey(): string {
  const appKey = process.env.APP_KEY
  if (!appKey) {
    throw new CryptoException(
      'keyprovider_missing',
      '[crypto] APP_KEY is not set; the env KeyProvider derives the KEK from it. Set APP_KEY, or bind a KMS/Vault provider.'
    )
  }
  return appKey
}

/**
 * The per-tenant KEK, HKDF-derived from `APP_KEY` (foundation §2.1: "ideally
 * per-tenant"). Per-tenant so a tenant's key material is destroyable and rotatable
 * independently. Honest limit (§10): because the KEK is a pure function of
 * `APP_KEY`, a DB-plus-app compromise (which already holds `APP_KEY`) can re-derive
 * it, so the env provider gives destruction granularity but NOT root-of-trust
 * separation. Prod uses a KMS/HSM.
 */
function deriveKek(appKey: string, tenantId: string): Buffer {
  return Buffer.from(
    hkdfSync(
      'sha256',
      Buffer.from(appKey, 'utf8'),
      KEK_SALT,
      Buffer.from(tenantId, 'utf8'),
      DEK_BYTES
    )
  )
}

/**
 * A non-secret tag of the current KEK generation. It changes when `APP_KEY`
 * changes, so a wrap made under an old `APP_KEY` carries an old `kek_id` and its
 * unwrap under the re-derived (new) KEK fails the GCM tag loudly rather than
 * returning garbage (the APP_KEY-axis rotation cursor, §6.7). Never a secret.
 */
function envKekId(appKey: string): string {
  // Hyphen, never a colon: the enc_v2 envelope is colon-delimited, so a colon in
  // the keyId would split into extra segments and corrupt the frame.
  return (
    'env-' +
    Buffer.from(
      hkdfSync('sha256', Buffer.from(appKey, 'utf8'), KEK_ID_SALT, KEK_ID_INFO, KEK_ID_BYTES)
    ).toString('hex')
  )
}

/**
 * The env-derived KeyProvider (the dev / zero-config default, §12.1). It wraps a
 * DEK by sealing it under the per-tenant KEK with core's enc_v2 GCM primitive
 * (`sealV2WithKey`), so there is exactly ONE AEAD in the platform and crypto
 * writes no new cipher. It is a real, working provider (crypto-shred works, DEKs
 * rotate), just with a dev-grade root of trust. Prod binds `aws-kms` /
 * `hashicorp-vault` on the registry instead.
 */
export default class EnvKeyProvider implements KeyProvider {
  readonly name = 'env'

  async wrapDek(tenantId: string, dek: Buffer): Promise<WrappedDek> {
    assertDek(dek)
    const appKey = requireAppKey()
    const kek = deriveKek(appKey, tenantId)
    const kekId = envKekId(appKey)
    // The DEK is 32 raw bytes; base64 it to a string for the enc_v2 envelope.
    const ciphertext = sealV2WithKey(dek.toString('base64'), kek, kekId)
    return { kekId, ciphertext }
  }

  async unwrapDek(tenantId: string, wrapped: WrappedDek): Promise<Buffer> {
    const appKey = requireAppKey()
    const kek = deriveKek(appKey, tenantId)
    // Strict: a tampered wrap, or one made under a different APP_KEY-derived KEK,
    // fails the GCM auth tag and throws (never returns a usable key).
    const dek = Buffer.from(openV2WithKey(wrapped.ciphertext, kek), 'base64')
    assertDek(dek)
    return dek
  }
}

function assertDek(dek: Buffer): void {
  if (dek.length !== DEK_BYTES) {
    throw new CryptoException(
      'dek_invalid',
      `[crypto] a DEK must be ${DEK_BYTES} bytes, got ${dek.length}.`
    )
  }
}

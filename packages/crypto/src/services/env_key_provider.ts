import { hkdfSync } from 'node:crypto'
import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'
import { DEK_BYTES, INDEX_KEY_BYTES } from '../constants.js'
import CryptoException from '../exceptions/crypto_exception.js'
import type { CategoryKey, KeyProvider, WrappedDek } from '../types/key_provider.js'

// Domain-separation salts for the env KEK derivation. Distinct from core's
// secret-at-rest salts so the KEK is never the same bytes as an APP_KEY-derived
// data key. Frozen: changing them re-derives every KEK and bricks stored wraps.
const KEK_SALT = Buffer.from('lasagna:crypto:kek:v1')
const KEK_ID_SALT = Buffer.from('lasagna:crypto:kek-id:v1')
const KEK_ID_INFO = Buffer.from('kek-id')
const KEK_ID_BYTES = 8

// Domain-separation salt for the env blind-index key. Distinct from KEK_SALT so a
// blind-index key can never be the same bytes as a KEK or a DEK (a different HKDF
// salt with the same APP_KEY yields an independent key). Frozen: changing it
// re-derives every index key and breaks equality against stored index columns.
const INDEX_KEY_SALT = Buffer.from('lasagna:crypto:blind-index:v1')

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

  /**
   * Derive the per-`(tenant × category)` blind-index key (§6.5, I5). It is a pure
   * function of `APP_KEY` (not the wrapped-DEK row), so it SURVIVES a crypto-shred
   * (T14): destroying a subject's DEK makes the field ciphertext inert while
   * equality stays computable for surviving rows. Per-`(tenant × category)` so two
   * categories never share an index keyspace and one tenant's key is independent
   * of another's. Honest limit (§10): as with the env KEK, the key is recoverable
   * by anyone who already holds `APP_KEY`; a prod KMS provider holds it out of the
   * app process.
   */
  async deriveIndexKey(tenantId: string, category: CategoryKey): Promise<Buffer> {
    const appKey = requireAppKey()
    return Buffer.from(
      hkdfSync(
        'sha256',
        Buffer.from(appKey, 'utf8'),
        INDEX_KEY_SALT,
        indexKeyInfo(tenantId, category),
        INDEX_KEY_BYTES
      )
    )
  }
}

/**
 * Unambiguous HKDF `info` for the per-`(tenant × category)` index key. JSON-encoding
 * the pair length-delimits it, so `(tenant 'a:b', category 'c')` and `(tenant 'a',
 * category 'b:c')` never derive the same key (a naive `${tenant}:${category}`
 * would collide them).
 */
function indexKeyInfo(tenantId: string, category: string): Buffer {
  return Buffer.from(JSON.stringify([tenantId, category]), 'utf8')
}

function assertDek(dek: Buffer): void {
  if (dek.length !== DEK_BYTES) {
    throw new CryptoException(
      'dek_invalid',
      `[crypto] a DEK must be ${DEK_BYTES} bytes, got ${dek.length}.`
    )
  }
}

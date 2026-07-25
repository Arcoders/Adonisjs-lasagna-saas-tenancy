import { DEK_BYTES } from '../constants.js'
import CryptoException from '../exceptions/crypto_exception.js'
import HttpKeyProvider, { type HttpKeyProviderOptions } from './http_key_provider.js'
import type { WrappedDek } from '../types/key_provider.js'

/** Configuration for the reference HashiCorp Vault (transit engine) KeyProvider. */
export interface VaultKeyProviderOptions extends HttpKeyProviderOptions {
  /** The Vault base address, e.g. `https://vault.internal:8200`. Routed through safeFetch. */
  readonly address: string
  /** A Vault token with `transit/encrypt` + `transit/decrypt` on the key(s) below. */
  readonly token: string
  /** The transit secrets-engine mount path. Default `transit`. */
  readonly mount?: string
  /**
   * The transit key name prefix. The per-tenant KEK is `${keyPrefix}${tenantId}` so a
   * tenant's key material is rotated/destroyed independently. Pre-create the keys, or
   * enable Vault's upsert. Default `lasagna-crypto-`.
   */
  readonly keyPrefix?: string
  /** The registry name a host binds this under (and names in `config.crypto.keyProvider`). Default `hashicorp-vault`. */
  readonly name?: string
}

/**
 * A reference production KeyProvider backed by HashiCorp Vault's transit engine. It
 * wraps a DEK by asking Vault to encrypt it (`transit/encrypt/<key>`) and unwraps it via
 * `transit/decrypt/<key>`, so raw KEK bytes never enter the app process (unlike the
 * dev `env` provider). It extends {@link HttpKeyProvider}, so
 * every outbound call is pinned by core `safeFetch`: a mis-set `address` cannot
 * reach loopback / RFC-1918 / cloud-metadata.
 *
 * The `kekId` cursor is Vault's transit key version (`vN`); a KEK rotation in Vault
 * (`transit/keys/<key>/rotate`) bumps `latest_version`, which `tenant:crypto:rekek`
 * re-wraps toward via {@link currentKekId}. Unwrap needs no version: Vault's ciphertext
 * embeds it. This is a working reference; a host may bind AWS KMS or a custom backend on
 * the same base instead.
 */
export default class VaultKeyProvider extends HttpKeyProvider {
  readonly name: string
  readonly #address: string
  readonly #token: string
  readonly #mount: string
  readonly #keyPrefix: string

  constructor(options: VaultKeyProviderOptions) {
    super(options)
    if (!options.address || !options.token) {
      throw new CryptoException(
        'config_invalid',
        '[crypto] VaultKeyProvider requires both an address and a token.'
      )
    }
    this.name = options.name ?? 'hashicorp-vault'
    this.#address = options.address.replace(/\/+$/, '')
    this.#token = options.token
    this.#mount = options.mount ?? 'transit'
    this.#keyPrefix = options.keyPrefix ?? 'lasagna-crypto-'
  }

  async wrapDek(tenantId: string, dek: Buffer): Promise<WrappedDek> {
    assertDek(dek)
    const data = await this.#transit('encrypt', tenantId, { plaintext: dek.toString('base64') })
    return { kekId: `v${asNumber(data.key_version)}`, ciphertext: asString(data.ciphertext) }
  }

  async unwrapDek(tenantId: string, wrapped: WrappedDek): Promise<Buffer> {
    const data = await this.#transit('decrypt', tenantId, { ciphertext: wrapped.ciphertext })
    const dek = Buffer.from(asString(data.plaintext), 'base64')
    assertDek(dek)
    return dek
  }

  /** The current KEK generation for a tenant (Vault's transit key `latest_version`). */
  async currentKekId(tenantId: string): Promise<string> {
    const json = await this.requestJson({
      url: `${this.#address}/v1/${this.#mount}/keys/${encodeURIComponent(this.#keyName(tenantId))}`,
      headers: this.#headers(),
    })
    return `v${asNumber(asRecord(json.data).latest_version)}`
  }

  #keyName(tenantId: string): string {
    return `${this.#keyPrefix}${tenantId}`
  }

  #headers(): Record<string, string> {
    return { 'X-Vault-Token': this.#token, 'Content-Type': 'application/json' }
  }

  /** POST a transit `encrypt`/`decrypt` op and return the response `data` object. */
  async #transit(
    op: 'encrypt' | 'decrypt',
    tenantId: string,
    body: Record<string, string>
  ): Promise<Record<string, unknown>> {
    const json = await this.requestJson({
      url: `${this.#address}/v1/${this.#mount}/${op}/${encodeURIComponent(this.#keyName(tenantId))}`,
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(body),
    })
    return asRecord(json.data)
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

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object') return value as Record<string, unknown>
  throw new CryptoException(
    'keyprovider_unavailable',
    '[crypto] Vault returned an unexpected (non-object) response.'
  )
}

function asString(value: unknown): string {
  if (typeof value === 'string') return value
  throw new CryptoException(
    'keyprovider_unavailable',
    '[crypto] Vault returned an unexpected (non-string) field.'
  )
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value
  throw new CryptoException(
    'keyprovider_unavailable',
    '[crypto] Vault returned an unexpected (non-number) field.'
  )
}

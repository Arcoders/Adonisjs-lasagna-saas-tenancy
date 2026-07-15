import { safeFetch } from '@adonisjs-lasagna/saas-tenancy/safe-fetch'
import { CRYPTO_CONTRACT_VERSION } from '../sdk/contract_version.js'
import CryptoException from '../exceptions/crypto_exception.js'
import { emitCryptoGuardEvent } from '../isthmus/crypto_guard_audit.js'
import type { KeyProvider, WrappedDek } from '../types/key_provider.js'

/** Options common to every HTTP-backed KeyProvider (KMS / Vault). */
export interface HttpKeyProviderOptions {
  /** Per-request timeout (ms) for the key backend. Default 5000. */
  readonly timeoutMs?: number
}

/** A single outbound call a subclass issues against its key backend. */
export interface HttpKeyRequest {
  readonly url: string
  readonly method?: string
  readonly headers?: Record<string, string>
  readonly body?: string
}

/**
 * The base class for any HTTP-backed KeyProvider (AWS KMS, HashiCorp Vault, a custom
 * KMS proxy). It exists so that SSRF protection is enforced by construction, not
 * by documentation: every outbound request goes through core's `safeFetch` (DNS/IP pin,
 * no redirects, RFC-1918 / loopback / cloud-metadata blocked), so a mis-configured or
 * attacker-influenced backend URL can never reach an internal address. Subclasses issue
 * requests only through {@link request} / {@link requestJson}; they NEVER call
 * `globalThis.fetch`, `http.request`, or a third-party HTTP client. This discipline is
 * pinned structurally by `check-crypto-invariant-11` (the only crypto src file allowed
 * to reference `safeFetch` is this one, and it MUST route through it), so a future
 * provider cannot open a second, unpinned egress path.
 *
 * It declares `contractVersion` so a subclass registers cleanly through
 * `KeyProviderRegistry` (the AI/billing extension-compat gate).
 */
export default abstract class HttpKeyProvider implements KeyProvider {
  abstract readonly name: string
  readonly contractVersion: number = CRYPTO_CONTRACT_VERSION
  readonly #timeoutMs: number

  constructor(options: HttpKeyProviderOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 5000
  }

  abstract wrapDek(tenantId: string, dek: Buffer): Promise<WrappedDek>
  abstract unwrapDek(tenantId: string, wrapped: WrappedDek): Promise<Buffer>

  /**
   * Issue one request against the key backend through core `safeFetch` (the only
   * egress path). A network / SSRF-pin / non-2xx failure fails closed: it emits
   * `guard.crypto_keyprovider_unavailable` and throws `keyprovider_unavailable`, so a
   * wrap/unwrap never proceeds against an unreachable or blocked backend (a read that
   * cannot unwrap is separately surfaced by CryptoService, never a plaintext fallback).
   */
  protected async request(req: HttpKeyRequest): Promise<Response> {
    let response: Response
    try {
      response = await safeFetch(req.url, {
        method: req.method ?? 'GET',
        ...(req.headers !== undefined ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        timeoutMs: this.#timeoutMs,
      })
    } catch (error) {
      emitCryptoGuardEvent('guard.crypto_keyprovider_unavailable')
      throw new CryptoException(
        'keyprovider_unavailable',
        `[crypto] the '${this.name}' KeyProvider backend is unreachable or blocked by the SSRF pin: ${errorMessage(error)}`
      )
    }
    if (!response.ok) {
      emitCryptoGuardEvent('guard.crypto_keyprovider_unavailable')
      throw new CryptoException(
        'keyprovider_unavailable',
        `[crypto] the '${this.name}' KeyProvider backend returned HTTP ${response.status}.`
      )
    }
    return response
  }

  /** Issue a request and parse a JSON object body (fail-closed on a non-JSON body). */
  protected async requestJson(req: HttpKeyRequest): Promise<Record<string, unknown>> {
    const response = await this.request(req)
    try {
      return (await response.json()) as Record<string, unknown>
    } catch (error) {
      emitCryptoGuardEvent('guard.crypto_keyprovider_unavailable')
      throw new CryptoException(
        'keyprovider_unavailable',
        `[crypto] the '${this.name}' KeyProvider backend returned a non-JSON body: ${errorMessage(error)}`
      )
    }
  }
}

/** The message of an unknown thrown value (never key material). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

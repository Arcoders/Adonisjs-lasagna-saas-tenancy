import { randomBytes } from 'node:crypto'
import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/crypto'
import { DEK_BYTES, INDEX_KEY_BYTES } from '../constants.js'
import CryptoException from '../exceptions/crypto_exception.js'
import { computeBlindIndex, type BlindIndexOptions } from '../internal/blind_index.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey, KeyProvider, SubjectId } from '../types/key_provider.js'
import type { ErasabilityResolver } from '../types/erasability.js'
import type { ShredLedger } from '../types/shred_ledger.js'
import type { SubjectShreddedEvent } from '../events/subject_shredded.js'
import type { WrappedDekStore } from './wrapped_dek_store.js'

export interface CryptoServiceDeps {
  /** The resolved KeyProvider (the one named by `config.crypto.keyProvider`). */
  readonly keyProvider: KeyProvider
  /** The persistence seam for the per-tenant wrapped-DEK table. */
  readonly store: WrappedDekStore
  /** DEK generator; defaults to `randomBytes(32)`. Injectable for deterministic tests. */
  readonly generateDek?: () => Buffer
  /**
   * Governance's erasability gate (I7). ABSENT ⇒ every shred is refused
   * (fail-closed: crypto never erases on its own initiative). Wired from
   * `config.crypto.erasabilityResolver` when governance is installed.
   */
  readonly erasabilityResolver?: ErasabilityResolver
  /**
   * The fail-closed WORM-ledger append seam (the shared core `WormLedgerWriter`).
   * ABSENT ⇒ every shred is refused (an irreversible erasure is never run
   * unaudited).
   */
  readonly ledger?: ShredLedger
  /** Optional host notification after a COMMITTED shred (the `SubjectShredded` event). */
  readonly emitShredded?: (event: SubjectShreddedEvent) => void
}

/** The outcome of a {@link CryptoService.shred} call. */
export interface ShredResult {
  /** True if a live DEK was destroyed by this call. */
  readonly shredded: boolean
  /** True if there was no live DEK to shred (already shredded / never provisioned). */
  readonly alreadyShredded: boolean
  /** The event emitted on a real shred (absent when alreadyShredded). */
  readonly event?: SubjectShreddedEvent
}

/**
 * The field-encryption core (crypto §6). It resolves the per-`(subject ×
 * category)` DEK from the wrapped-DEK store (provisioning one on first write),
 * unwraps it through the {@link KeyProvider}, and seals/opens the field value with
 * core's enc_v2 GCM primitive via the `sealV2WithKey`/`openV2WithKey` seam. Every
 * path is fail-closed (I3): a read whose DEK is gone (shredded / never
 * provisioned), or a value that is not enc_v2 ciphertext, THROWS rather than
 * returning plaintext. The DEK is the domain separator (I4/T7): a value sealed
 * under one category's DEK cannot open under another. Stateful only through the
 * injected store, so it is a container singleton (never `new`-ed per request).
 *
 * It also builds the deterministic search HMAC (`blindIndex`, §6.5, I5): a keyed
 * HMAC over a low-entropy field so equality search survives encryption, keyed by a
 * KeyProvider index key that is distinct from the DEK and survives a shred. The
 * per-tenant operation lock around provision (§6.6, I10) and the KEK-rotation
 * walker (§6.7) land in later phases.
 */
export default class CryptoService {
  readonly #keyProvider: KeyProvider
  readonly #store: WrappedDekStore
  readonly #generateDek: () => Buffer
  readonly #erasabilityResolver?: ErasabilityResolver
  readonly #ledger?: ShredLedger
  readonly #emitShredded?: (event: SubjectShreddedEvent) => void

  constructor(deps: CryptoServiceDeps) {
    this.#keyProvider = deps.keyProvider
    this.#store = deps.store
    this.#generateDek = deps.generateDek ?? (() => randomBytes(DEK_BYTES))
    this.#erasabilityResolver = deps.erasabilityResolver
    this.#ledger = deps.ledger
    this.#emitShredded = deps.emitShredded
  }

  /**
   * Encrypt a field value under the `(subject × category)` DEK, provisioning the
   * DEK on first write. Returns an enc_v2 ciphertext sealed under that DEK, so a
   * later crypto-shred of the DEK makes it irrecoverable (I6).
   */
  async encryptField(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey,
    plaintext: string
  ): Promise<string> {
    const { dek, keyId } =
      (await this.#liveDek(tenant, subjectId, category)) ??
      (await this.#provisionDek(tenant, subjectId, category))
    return sealV2WithKey(plaintext, dek, keyId)
  }

  /**
   * Decrypt a field value under the `(subject × category)` DEK. Fail-closed: if
   * the DEK was never provisioned or has been shredded, THROWS `dek_missing`
   * (never returns plaintext); a value that is not enc_v2 ciphertext, or one that
   * fails the DEK/GCM check, throws via the strict open path (I3, T6).
   */
  async decryptField(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey,
    ciphertext: string
  ): Promise<string> {
    const live = await this.#liveDek(tenant, subjectId, category)
    if (!live) {
      throw new CryptoException(
        'dek_missing',
        `[crypto] no live DEK for subject '${subjectId}' / category '${category}': it was never provisioned or has been shredded.`
      )
    }
    return openV2WithKey(ciphertext, live.dek)
  }

  /**
   * Build the deterministic blind index (a keyed HMAC) for equality search on a
   * low-entropy field (§6.5, I5). The host stores this value in its own index
   * column on write and queries `WHERE <col> = :index` on read; crypto owns the
   * keyed HMAC, the host owns the column. The index key is a KeyProvider capability
   * DISTINCT from the DEK: it is stable across rows (so equal plaintexts index
   * equally), and it SURVIVES a crypto-shred (equality stays computable for
   * surviving rows, T14). So this method does NOT resolve or touch the `(subject ×
   * category)` DEK at all, and does not need a subject.
   *
   * Fail-closed (§9): if the KeyProvider does not support blind indexing, or cannot
   * yield an index key, or yields one that is too short, this THROWS
   * `index_key_unavailable` rather than writing a brute-forceable unkeyed hash in
   * its place (T3).
   *
   * DOCUMENTED residual leak (I5, T4): a DB reader sees which rows share a value
   * and how often each occurs, and this persists across a shred until the host
   * nulls the index column. This is the standard searchable-encryption trade-off;
   * a host that cannot accept it must not mark the field searchable.
   */
  async blindIndex(
    tenant: TenantModelContract,
    category: CategoryKey,
    value: string,
    options: BlindIndexOptions = {}
  ): Promise<string> {
    // The index key is a KeyProvider capability distinct from wrap/unwrap. A
    // provider that cannot yield one (or is not wired for indexing) fails closed:
    // crypto never substitutes a brute-forceable unkeyed hash (T3).
    if (!this.#keyProvider.deriveIndexKey) {
      throw new CryptoException(
        'index_key_unavailable',
        `[crypto] the '${this.#keyProvider.name}' KeyProvider does not support blind indexing (no deriveIndexKey). Bind a provider that yields an index key, or do not mark the field searchable.`
      )
    }
    let indexKey: Buffer
    try {
      indexKey = await this.#keyProvider.deriveIndexKey(tenant.id, category)
    } catch (error) {
      throw new CryptoException(
        'index_key_unavailable',
        `[crypto] cannot build a blind index for category '${category}': the KeyProvider yielded no index key, so a brute-forceable unkeyed hash is never written in its place. Cause: ${errorMessage(error)}`
      )
    }
    if (indexKey.length < INDEX_KEY_BYTES) {
      throw new CryptoException(
        'index_key_unavailable',
        `[crypto] the KeyProvider returned a ${indexKey.length}-byte blind-index key for category '${category}'; it must be at least ${INDEX_KEY_BYTES} bytes.`
      )
    }
    return computeBlindIndex(indexKey, value, options)
  }

  /**
   * Crypto-shred a `(subject × category)`: the O(1) erasure (I6, §6.6). It
   * destroys the ONLY copy of the DEK, so every field ciphertext and every vault
   * blob under it (and their backups, which are ciphertext) becomes irrecoverable
   * at once. Fail-closed and gated:
   *
   *  1. Governance gate FIRST (I7): if no erasability resolver is wired
   *     (governance absent), or governance says the category is not erasable (a
   *     `legal-obligation` category in retention), the shred is REFUSED. crypto
   *     never erases on its own initiative; under-erasing is recoverable,
   *     over-erasing is not.
   *  2. Two-phase audit (§6.6): a PENDING WORM row is appended BEFORE the
   *     irreversible tombstone; if that append fails (or no ledger is wired) the
   *     shred ABORTS with nothing destroyed. After the tombstone the row is marked
   *     COMMITTED; a failure there leaves a detectable PENDING row (reported via
   *     `shred_audit_unfinalized`, never a silent success).
   *
   * Idempotent: re-shredding an already-shredded `(subject × category)` is a
   * no-op success (no ledger write, no event).
   */
  async shred(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<ShredResult> {
    // 1. Governance gate (I7). The FIRST awaited call. Absent resolver ⇒ refuse.
    if (!this.#erasabilityResolver) {
      throw new CryptoException(
        'shred_refused',
        `[crypto] refusing to shred subject '${subjectId}' / category '${category}': no erasability resolver is wired (governance absent). crypto never erases on its own initiative.`
      )
    }
    const verdict = await this.#erasabilityResolver(tenant, subjectId, category)
    if (!verdict.erasable) {
      const until = verdict.retentionUntil
        ? `, retained until ${verdict.retentionUntil.toISOString()}`
        : ''
      throw new CryptoException(
        'shred_refused',
        `[crypto] refusing to shred subject '${subjectId}' / category '${category}': not erasable (${verdict.reason ?? 'legal hold'}${until}).`
      )
    }

    // Nothing to erase ⇒ idempotent no-op (no ledger row, no event).
    const live = await this.#store.findLive(tenant, subjectId, category)
    if (!live) return { shredded: false, alreadyShredded: true }

    // 2. Two-phase audit. No ledger ⇒ refuse (never erase unaudited).
    if (!this.#ledger) {
      throw new CryptoException(
        'shred_unaudited',
        `[crypto] refusing to shred subject '${subjectId}' / category '${category}': no WORM ledger is wired, and an irreversible erasure is never run unaudited.`
      )
    }

    // 2a. PENDING before the delete. A throw here aborts with nothing destroyed.
    let pending
    try {
      pending = await this.#ledger.appendPending({
        tenantId: tenant.id,
        subjectId,
        category,
        reason: verdict.reason,
      })
    } catch (error) {
      throw new CryptoException(
        'shred_unaudited',
        `[crypto] aborting shred of subject '${subjectId}' / category '${category}': the WORM PENDING append failed, so nothing was destroyed. Cause: ${errorMessage(error)}`
      )
    }

    // 2b. The irreversible tombstone (destroy the DEK).
    await this.#store.shredLive(tenant, subjectId, category)

    // 2c. COMMITTED after the delete. A failure here does NOT undo the erasure
    // (the DEK is gone, correctly); it leaves a detectable PENDING row, reported.
    try {
      await this.#ledger.markCommitted(pending)
    } catch (error) {
      throw new CryptoException(
        'shred_audit_unfinalized',
        `[crypto] shred of subject '${subjectId}' / category '${category}' COMPLETED (the DEK is destroyed), but marking the WORM row COMMITTED failed; a detectable PENDING row remains for reconciliation. Cause: ${errorMessage(error)}`
      )
    }

    const event: SubjectShreddedEvent = {
      tenantId: tenant.id,
      subjectId,
      category,
      occurredAt: new Date(),
    }
    this.#emitShredded?.(event)
    return { shredded: true, alreadyShredded: false, event }
  }

  /** Resolve the live DEK for (subject, category), or null if none is provisioned. */
  async #liveDek(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<{ dek: Buffer; keyId: string } | null> {
    const row = await this.#store.findLive(tenant, subjectId, category)
    if (!row) return null
    const dek = await this.#keyProvider.unwrapDek(tenant.id, {
      kekId: row.kekId,
      ciphertext: row.wrappedDek,
    })
    this.#assertDek(dek)
    // The row id is the non-secret `keyId` tag stamped into the envelope, so a
    // read/rotation can tell which DEK sealed a value.
    return { dek, keyId: row.id }
  }

  /** Generate + wrap a fresh DEK and persist it as the live row for (subject, category). */
  async #provisionDek(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<{ dek: Buffer; keyId: string }> {
    const dek = this.#generateDek()
    this.#assertDek(dek)
    const wrapped = await this.#keyProvider.wrapDek(tenant.id, dek)
    const row = await this.#store.insert(tenant, {
      subjectId,
      category,
      wrappedDek: wrapped.ciphertext,
      kekId: wrapped.kekId,
    })
    return { dek, keyId: row.id }
  }

  #assertDek(dek: Buffer): void {
    if (dek.length !== DEK_BYTES) {
      throw new CryptoException(
        'dek_invalid',
        `[crypto] an unwrapped DEK must be ${DEK_BYTES} bytes, got ${dek.length}.`
      )
    }
  }
}

/** The message of an unknown thrown value, for a ledger-failure cause string. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

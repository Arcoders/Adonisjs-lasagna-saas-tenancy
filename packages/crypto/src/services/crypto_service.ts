import { randomBytes } from 'node:crypto'
import { sealV2WithKey, openV2WithKey } from '@adonisjs-lasagna/saas-tenancy/internal'
import { DEK_BYTES, INDEX_KEY_BYTES } from '../constants.js'
import CryptoException from '../exceptions/crypto_exception.js'
import { emitCryptoGuardEvent } from '../isthmus/crypto_guard_audit.js'
import { computeBlindIndex, type BlindIndexOptions } from '../internal/blind_index.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { CategoryKey, KeyProvider, SubjectId } from '../types/key_provider.js'
import type { ErasabilityResolver } from '../types/erasability.js'
import type { ShredLedger } from '../types/shred_ledger.js'
import type { CryptoLockOptions, CryptoOperationLock } from '../types/operation_lock.js'
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
   * Governance's erasability gate. When it is absent every shred is refused: crypto
   * fails closed and never erases on its own initiative. Wired from
   * `config.crypto.erasabilityResolver` when governance is installed.
   */
  readonly erasabilityResolver?: ErasabilityResolver | undefined
  /**
   * The fail-closed WORM-ledger append seam (the shared core `WormLedgerWriter`).
   * When it is absent every shred is refused, because an irreversible erasure is
   * never run unaudited.
   */
  readonly ledger?: ShredLedger
  /** Optional host notification after a COMMITTED shred (the `SubjectShredded` event). */
  readonly emitShredded?: (event: SubjectShreddedEvent) => void
  /**
   * The per-tenant operation lock. Provision and shred serialize on it so two
   * concurrent writes to one `(subject × category)` DEK cannot interleave. When it
   * is absent the critical sections run without cross-process serialization, which
   * is a safe degraded mode: the partial UNIQUE index is the real singularity
   * guarantee. See {@link CryptoOperationLock}.
   */
  readonly withLock?: CryptoOperationLock
}

/** The outcome of a {@link CryptoService.shred} call. */
export interface ShredResult {
  /** True if a live DEK was destroyed by this call. */
  readonly shredded: boolean
  /** True if there was no live DEK to shred (already shredded / never provisioned). */
  readonly alreadyShredded: boolean
  /**
   * True when the call was a dry run: the governance gate and the fail-closed
   * preconditions were checked, but nothing was destroyed or audited. A
   * `{ shredded: false, alreadyShredded: false, dryRun: true }` result means a live
   * DEK exists and is erasable, so a real run would shred it.
   */
  readonly dryRun?: boolean
  /** The event emitted on a real shred (absent when alreadyShredded / dryRun). */
  readonly event?: SubjectShreddedEvent
}

/** A resolved DEK: the 32-byte key plus the non-secret `keyId` tag (the wrapped-DEK row id). */
interface ResolvedDek {
  readonly dek: Buffer
  readonly keyId: string
}

/** Options for {@link CryptoService.shred}. */
export interface ShredOptions {
  /**
   * Run the governance gate and the fail-closed preconditions, but destroy and audit
   * nothing. This backs `tenant:crypto:shred --dry-run`. A refused category still
   * throws so the operator sees the legal hold; an erasable live DEK returns
   * `{ shredded: false, alreadyShredded: false, dryRun: true }`.
   */
  readonly dryRun?: boolean
}

/**
 * The field-encryption core. It resolves the DEK for a `(subject × category)` from
 * the wrapped-DEK store (provisioning one on the first write), unwraps it through
 * the {@link KeyProvider}, and seals or opens the field value with core's enc_v2 GCM
 * primitive through the `sealV2WithKey`/`openV2WithKey` seam. Every path fails
 * closed: a read whose DEK is gone (shredded, or never provisioned), or a value that
 * is not enc_v2 ciphertext, throws rather than returning plaintext. The DEK is the
 * domain separator, so a value sealed under one category's DEK cannot open under
 * another. The service is stateful only through the injected store, so it lives as a
 * container singleton and is never `new`-ed per request.
 *
 * It also builds the deterministic search HMAC (`blindIndex`): a keyed HMAC over a
 * low-entropy field so equality search survives encryption. That HMAC is keyed by a
 * KeyProvider index key that is distinct from the DEK and outlives a shred, so
 * matching still works on the rows that remain.
 */
export default class CryptoService {
  readonly #keyProvider: KeyProvider
  readonly #store: WrappedDekStore
  readonly #generateDek: () => Buffer
  readonly #erasabilityResolver?: ErasabilityResolver | undefined
  readonly #ledger?: ShredLedger | undefined
  readonly #emitShredded?: ((event: SubjectShreddedEvent) => void) | undefined
  readonly #withLock?: CryptoOperationLock | undefined

  constructor(deps: CryptoServiceDeps) {
    this.#keyProvider = deps.keyProvider
    this.#store = deps.store
    this.#generateDek = deps.generateDek ?? (() => randomBytes(DEK_BYTES))
    this.#erasabilityResolver = deps.erasabilityResolver
    this.#ledger = deps.ledger
    this.#emitShredded = deps.emitShredded
    this.#withLock = deps.withLock
  }

  /**
   * Run `fn` under the per-tenant operation lock when one is wired, otherwise run it
   * directly. The lock serializes provision and shred so two concurrent writers to
   * one `(subject × category)` DEK cannot interleave. When no lock is wired, the
   * partial UNIQUE index is the fail-closed backstop, a safe degraded mode.
   */
  #locked<T>(tenantId: string, fn: () => Promise<T>, options?: CryptoLockOptions): Promise<T> {
    return this.#withLock ? this.#withLock(tenantId, fn, options) : fn()
  }

  /**
   * Encrypt a field value under the `(subject × category)` DEK, provisioning the
   * DEK on the first write. Returns an enc_v2 ciphertext sealed under that DEK, so a
   * later crypto-shred of the DEK makes the value irrecoverable.
   */
  async encryptField(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey,
    plaintext: string
  ): Promise<string> {
    // Fast path: an already-provisioned DEK needs no lock (it is only read).
    const { dek, keyId } =
      (await this.#liveDek(tenant, subjectId, category)) ??
      (await this.#provisionUnderLock(tenant, subjectId, category))
    return sealV2WithKey(plaintext, dek, keyId)
  }

  /**
   * Decrypt a field value under the `(subject × category)` DEK. This fails closed:
   * if the DEK was never provisioned or has been shredded, it throws `dek_missing`
   * and never returns plaintext. A value that is not enc_v2 ciphertext, or one that
   * fails the DEK or GCM check, throws through the strict open path.
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
   * low-entropy field. The host stores this value in its own index column on write
   * and queries `WHERE <col> = :index` on read: crypto owns the keyed HMAC, the host
   * owns the column. The index key is a KeyProvider capability distinct from the DEK.
   * It is stable across rows, so equal plaintexts index equally, and it survives a
   * crypto-shred, so equality stays computable for the rows that remain. Because of
   * that, this method does not resolve or touch the `(subject × category)` DEK at
   * all, and it does not need a subject.
   *
   * It fails closed: if the KeyProvider does not support blind indexing, or cannot
   * yield an index key, or yields one that is too short, it throws
   * `index_key_unavailable` rather than writing a brute-forceable unkeyed hash in
   * its place.
   *
   * One residual leak is documented and accepted: a database reader can see which
   * rows share a value and how often each occurs, and that stays visible across a
   * shred until the host nulls the index column. This is the usual trade-off of
   * searchable encryption. A host that cannot accept it should not mark the field
   * searchable.
   */
  async blindIndex(
    tenant: TenantModelContract,
    category: CategoryKey,
    value: string,
    options: BlindIndexOptions = {}
  ): Promise<string> {
    // The index key is a KeyProvider capability distinct from wrap/unwrap. A
    // provider that cannot yield one (or is not wired for indexing) fails closed:
    // crypto never substitutes a brute-forceable unkeyed hash.
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
   * Crypto-shred a `(subject × category)`: the O(1) erasure. It destroys the only
   * live copy of the DEK, so every live field ciphertext and every live vault blob
   * under it (and any backup taken after the shred) becomes irrecoverable at once.
   * The honest limit: a backup, clone, or query log written before the shred still
   * holds the wrapped DEK, which the surviving per-tenant KEK can unwrap, so erasing
   * those pre-shred copies stays the operator's retention and KEK-rotation job.
   *
   * The path is gated and fails closed:
   *
   *  1. The governance gate runs first. If no erasability resolver is wired
   *     (governance is absent), or governance says the category is not erasable (for
   *     example a `legal-obligation` category still in retention), the shred is
   *     refused. crypto never erases on its own initiative; under-erasing can be
   *     undone, over-erasing cannot.
   *  2. The audit is two-phase. A PENDING WORM row is appended before the
   *     irreversible tombstone; if that append fails, or no ledger is wired, the
   *     shred aborts with nothing destroyed. After the tombstone the row is marked
   *     COMMITTED. A failure at that last step leaves a detectable PENDING row,
   *     reported through `shred_audit_unfinalized`, never a silent success.
   *
   * The call is idempotent: re-shredding an already-shredded `(subject × category)`
   * is a no-op success, with no ledger write and no event.
   */
  async shred(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey,
    options?: ShredOptions
  ): Promise<ShredResult> {
    // 1. The governance gate, which is the first awaited call. An absent resolver refuses.
    if (!this.#erasabilityResolver) {
      emitCryptoGuardEvent('guard.crypto_shred_legal_hold', { tenantId: tenant.id })
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
      emitCryptoGuardEvent('guard.crypto_shred_legal_hold', { tenantId: tenant.id })
      throw new CryptoException(
        'shred_refused',
        `[crypto] refusing to shred subject '${subjectId}' / category '${category}': not erasable (${verdict.reason ?? 'legal hold'}${until}).`
      )
    }

    // Dry run: the gate passed. Check the fail-closed preconditions (a live DEK
    // exists, a WORM ledger is wired) but destroy and audit nothing, and take no lock.
    if (options?.dryRun) {
      const liveDry = await this.#store.findLive(tenant, subjectId, category)
      if (!liveDry) return { shredded: false, alreadyShredded: true, dryRun: true }
      if (!this.#ledger) {
        emitCryptoGuardEvent('guard.crypto_shred_unaudited', { tenantId: tenant.id })
        throw new CryptoException(
          'shred_unaudited',
          `[crypto] cannot shred subject '${subjectId}' / category '${category}': no WORM ledger is wired, and an irreversible erasure is never run unaudited.`
        )
      }
      return { shredded: false, alreadyShredded: false, dryRun: true }
    }

    // Ledger precondition, checked once before acquiring the lock, because an
    // irreversible erasure is never run unaudited. Capturing it in a local also
    // narrows it to non-null for the closure below, so the check never has to run
    // inside the lock.
    const ledger = this.#ledger
    if (!ledger) {
      emitCryptoGuardEvent('guard.crypto_shred_unaudited', { tenantId: tenant.id })
      throw new CryptoException(
        'shred_unaudited',
        `[crypto] refusing to shred subject '${subjectId}' / category '${category}': no WORM ledger is wired, and an irreversible erasure is never run unaudited.`
      )
    }

    // 2. The destructive two-phase erasure, serialized under the per-tenant operation
    // lock in `serialize` mode: a concurrent shred waits rather than running
    // unserialized, so the two-phase audit never double-appends. If Redis is down the
    // lock degrades to fail-open, and the authoritative delete-count returned in step
    // 2b is the backstop that prevents a double COMMITTED and a double emit.
    return this.#locked(
      tenant.id,
      async () => {
        // Re-check under the lock: a concurrent shred may have completed between the
        // gate and acquiring the lock (idempotent no-op, no double audit).
        const live = await this.#store.findLive(tenant, subjectId, category)
        if (!live) return { shredded: false, alreadyShredded: true }

        // 2a. PENDING before the delete. A throw here aborts with nothing destroyed.
        let pending
        try {
          pending = await ledger.appendPending({
            tenantId: tenant.id,
            subjectId,
            category,
            reason: verdict.reason,
          })
        } catch (error) {
          emitCryptoGuardEvent('guard.crypto_shred_unaudited', { tenantId: tenant.id })
          throw new CryptoException(
            'shred_unaudited',
            `[crypto] aborting shred of subject '${subjectId}' / category '${category}': the WORM PENDING append failed, so nothing was destroyed. Cause: ${errorMessage(error)}`
          )
        }

        // 2b. The irreversible tombstone that destroys the DEK. This is authoritative:
        // only the caller that actually tombstoned the live row goes on to mark
        // COMMITTED and emit. If it returns false we lost a concurrent race, which is
        // only reachable in the Redis-down degraded mode. Our PENDING row is then a
        // detectable orphan, resolved exactly like a crash between PENDING and
        // COMMITTED, and never a double audit.
        const didShred = await this.#store.shredLive(tenant, subjectId, category)
        if (!didShred) return { shredded: false, alreadyShredded: true }

        // 2c. Mark COMMITTED after the delete. A failure here does not undo the
        // erasure (the DEK is already gone, which is correct); it leaves a detectable
        // PENDING row, which is reported.
        try {
          await ledger.markCommitted(pending)
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
      },
      { onContention: 'serialize' }
    )
  }

  /** Resolve the live DEK for (subject, category), or null if none is provisioned. */
  async #liveDek(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<ResolvedDek | null> {
    const row = await this.#store.findLive(tenant, subjectId, category)
    if (!row) return null
    let dek: Buffer
    try {
      dek = await this.#keyProvider.unwrapDek(tenant.id, {
        kekId: row.kekId,
        ciphertext: row.wrappedDek,
      })
    } catch (error) {
      // A DEK that cannot be unwrapped (KMS down, wrong KEK, tamper) makes the read
      // fail closed. Surface the error; never fall back to a shared or plaintext key.
      emitCryptoGuardEvent('guard.crypto_dek_unwrap_failed', { tenantId: tenant.id })
      throw error
    }
    this.#assertDek(dek)
    // The row id is the non-secret `keyId` tag stamped into the envelope, so a read
    // or rotation can tell which DEK sealed a value.
    return { dek, keyId: row.id }
  }

  /**
   * Provision a DEK under the per-tenant operation lock, re-checking for a live DEK
   * inside the lock so that two concurrent first-writers to one `(subject ×
   * category)` resolve to a single DEK (the loser reuses the winner's) instead of
   * racing on the partial UNIQUE index. When no lock is wired, that partial UNIQUE
   * index is the fail-closed backstop: a racing second insert is refused with
   * `dek_conflict`.
   */
  async #provisionUnderLock(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<ResolvedDek> {
    return this.#locked(tenant.id, async () => {
      return (
        (await this.#liveDek(tenant, subjectId, category)) ??
        (await this.#provisionDek(tenant, subjectId, category))
      )
    })
  }

  /** Generate and wrap a fresh DEK, then persist it as the live row for (subject, category). */
  async #provisionDek(
    tenant: TenantModelContract,
    subjectId: SubjectId,
    category: CategoryKey
  ): Promise<ResolvedDek> {
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

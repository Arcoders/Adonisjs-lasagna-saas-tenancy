import { classifyRekek } from '../internal/rekek.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { KeyProvider } from '../types/key_provider.js'
import type { WrappedDekStore } from './wrapped_dek_store.js'

export interface RekekServiceDeps {
  /** The resolved KeyProvider (the one named by `config.crypto.keyProvider`). */
  readonly keyProvider: KeyProvider
  /** The persistence seam for the per-tenant wrapped-DEK table. */
  readonly store: WrappedDekStore
  /** Page size for the keyset walk. Defaults to 500; injectable for tests. */
  readonly batchSize?: number
}

/** A DEK the walker could not unwrap under any KEK generation it holds (reported, never silent). */
export interface RekekFailure {
  readonly id: string
  readonly subjectId: string
  readonly category: string
  /** The stored `kek_id` that matched no known KEK generation. */
  readonly kekId: string
  /** The unwrap error message (never key material). */
  readonly reason: string
}

/** The honest per-tenant outcome of a {@link RekekService.rekekTenant} pass. */
export interface RekekTenantSummary {
  /** Live wrapped-DEK rows scanned. `scanned === current + rotated + shreddedDuringRewrap + failed`. */
  readonly scanned: number
  /** Rows already at the current KEK generation (skipped, no write). */
  readonly current: number
  /** Rows re-wrapped under the current KEK (or that WOULD be, under `dryRun`). */
  readonly rotated: number
  /**
   * Rows whose re-wrap unwrap+wrap succeeded but whose UPDATE tombstoned nothing
   * because the row was crypto-shredded between the scan and the write (a benign
   * race: its key material is already destroyed, nothing live to re-wrap). Counted
   * on its own axis so `current` keeps meaning "already at the target KEK, skipped".
   */
  readonly shreddedDuringRewrap: number
  /** Rows that unwrap under no known KEK generation (reported for operator attention). */
  readonly failed: number
  /** The detail for each failed row. */
  readonly failures: readonly RekekFailure[]
}

export interface RekekOptions {
  /** Classify and report, but write nothing (no re-wrap). */
  readonly dryRun?: boolean
}

/**
 * The KEK-rotation walker (I8, §6.7). Rotating the KEK does NOT re-encrypt field
 * values: for every LIVE wrapped-DEK row it unwraps the DEK under the old KEK and
 * re-wraps it under the current one, updating `kek_id`. The data ciphertext (sealed
 * under the DEK, whose bytes and the row-id `keyId` tag are both unchanged) keeps
 * decrypting, so this is O(number of DEKs), never O(number of field values).
 *
 * It reuses the current/rotate/failed classification PATTERN of core's
 * `secrets_rotation.ts` (foundation §6) but not its function: that classifies
 * enc_v2 VALUE strings via `decryptWithAppKey`; this classifies WRAPPED-DEK
 * ENVELOPES via `KeyProvider.unwrapDek`/`wrapDek`, a different data type against a
 * different key store. This module deliberately imports NOTHING from core's crypto
 * primitive: it must never `openV2WithKey`-then-`sealV2WithKey` a field value
 * (I8, `check-crypto-invariant-8`).
 *
 * Idempotent and resumable: a re-run skips rows already at the current `kek_id`
 * (the cursor), and the keyset walk visits every live row exactly once even under a
 * concurrent re-wrap. A row that cannot be unwrapped under any generation the
 * provider holds is reported `failed` (its data must be restored from backup or
 * re-entered), mirroring `tenant:secrets:reencrypt`'s failed-row reporting. Stateless
 * beyond its injected deps.
 */
export default class RekekService {
  readonly #keyProvider: KeyProvider
  readonly #store: WrappedDekStore
  readonly #batchSize: number

  constructor(deps: RekekServiceDeps) {
    this.#keyProvider = deps.keyProvider
    this.#store = deps.store
    this.#batchSize = deps.batchSize && deps.batchSize > 0 ? Math.floor(deps.batchSize) : 500
  }

  /** Re-wrap every live DEK of one tenant under the current KEK generation. */
  async rekekTenant(
    tenant: TenantModelContract,
    options: RekekOptions = {}
  ): Promise<RekekTenantSummary> {
    const dryRun = options.dryRun ?? false
    // The cheap cursor: rows already at this generation are skipped without an
    // unwrap. Absent (a provider that cannot report it) ⇒ post-hoc classification.
    const currentKekId = this.#keyProvider.currentKekId
      ? await this.#keyProvider.currentKekId(tenant.id)
      : undefined

    let scanned = 0
    let current = 0
    let rotated = 0
    let shreddedDuringRewrap = 0
    let failed = 0
    const failures: RekekFailure[] = []
    let afterId: string | undefined

    for (;;) {
      const rows = await this.#store.listLive(tenant, { afterId, limit: this.#batchSize })
      if (rows.length === 0) break

      for (const row of rows) {
        scanned++
        afterId = row.id // advance the keyset cursor (a re-wrap keeps the id)

        if (classifyRekek(row.kekId, currentKekId) === 'current') {
          current++
          continue
        }

        // Re-WRAP (I8): unwrap the DEK under whatever KEK generation the provider
        // still holds, then re-wrap under the current one. NEVER a field-value
        // decrypt/re-encrypt (no openV2WithKey/sealV2WithKey in this module).
        let dek: Buffer
        try {
          dek = await this.#keyProvider.unwrapDek(tenant.id, {
            kekId: row.kekId,
            ciphertext: row.wrappedDek,
          })
        } catch (error) {
          failed++
          failures.push({
            id: row.id,
            subjectId: row.subjectId,
            category: row.category,
            kekId: row.kekId,
            reason: errorMessage(error),
          })
          continue
        }

        const wrapped = await this.#keyProvider.wrapDek(tenant.id, dek)
        // Post-hoc idempotence: with no cursor, a row already current re-wraps to
        // the same generation — count it as current, write nothing.
        if (wrapped.kekId === row.kekId) {
          current++
          continue
        }
        if (dryRun) {
          rotated++
          continue
        }
        const updated = await this.#store.rewrap(tenant, row.id, wrapped.ciphertext, wrapped.kekId)
        if (updated) rotated++
        // A row shredded between the scan and here is a benign race: nothing live to
        // re-wrap, and its key material is already destroyed. Counted on its own axis
        // (not `current`) so the accounting invariant stays exact.
        else shreddedDuringRewrap++
      }

      if (rows.length < this.#batchSize) break
    }

    return { scanned, current, rotated, shreddedDuringRewrap, failed, failures }
  }
}

/** The message of an unknown thrown value, for a failure report (never key material). */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

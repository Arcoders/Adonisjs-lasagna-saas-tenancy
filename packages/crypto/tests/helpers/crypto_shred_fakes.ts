import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import CryptoService from '../../src/services/crypto_service.js'
import EnvKeyProvider from '../../src/services/env_key_provider.js'
import InMemoryWrappedDekStore from '../../src/testing/in_memory_wrapped_dek_store.js'
import type { ErasabilityResolver } from '../../src/types/erasability.js'
import type {
  PendingShredEntry,
  ShredLedger,
  ShredLedgerEntry,
} from '../../src/types/shred_ledger.js'
import type { CryptoOperationLock } from '../../src/types/operation_lock.js'
import type { SubjectShreddedEvent } from '../../src/events/subject_shredded.js'

/** A fake tenant: CryptoService + the in-memory store only ever read `.id`. */
export function tenant(id: string): TenantModelContract {
  return { id } as unknown as TenantModelContract
}

/** A recording WORM ledger double, optionally made to fail at either phase. */
export class RecordingLedger implements ShredLedger {
  readonly pending: ShredLedgerEntry[] = []
  readonly committed: string[] = []
  #seq = 0

  constructor(private readonly opts: { failAppend?: boolean; failCommit?: boolean } = {}) {}

  async appendPending(entry: ShredLedgerEntry): Promise<PendingShredEntry> {
    if (this.opts.failAppend) throw new Error('WORM PENDING append failed')
    this.pending.push(entry)
    return { id: `pending-${++this.#seq}`, tenantId: entry.tenantId }
  }

  async markCommitted(pending: PendingShredEntry): Promise<void> {
    if (this.opts.failCommit) throw new Error('WORM COMMITTED mark failed')
    this.committed.push(pending.id)
  }
}

/** A resolver that says every category is erasable (a consent basis). */
export const erasable =
  (reason = 'consent'): ErasabilityResolver =>
  () => ({ erasable: true, reason })

/** A resolver that refuses erasure (a legal hold), optionally with a retention date. */
export const notErasable =
  (reason = 'legal-obligation', retentionUntil?: Date): ErasabilityResolver =>
  () =>
    // Omit the key entirely when there is no retention date. The verdict contract
    // takes `Date | null`, so carrying an explicit undefined is not a legal verdict.
    retentionUntil ? { erasable: false, reason, retentionUntil } : { erasable: false, reason }

/** A resolver that decides erasability by category (the worked example: consent vs legal-obligation). */
export const byCategory =
  (erasableCategories: readonly string[]): ErasabilityResolver =>
  (_tenant, _subject, category) =>
    erasableCategories.includes(category)
      ? { erasable: true, reason: 'consent' }
      : { erasable: false, reason: 'legal-obligation' }

/**
 * A recording per-tenant operation lock that serializes calls (a real mutex) and
 * counts acquisitions, so a test can assert the provision/shred path ran under it.
 */
export class RecordingLock {
  acquisitions = 0
  #chain: Promise<unknown> = Promise.resolve()

  readonly lock: CryptoOperationLock = <T>(_tenantId: string, fn: () => Promise<T>): Promise<T> => {
    this.acquisitions++
    // Serialize: each call waits for the previous to finish (models Redis mutual
    // exclusion within the process), so a race resolves deterministically.
    const run = this.#chain.then(() => fn())
    this.#chain = run.catch(() => {})
    return run as Promise<T>
  }
}

/** Wire a CryptoService to the env provider + an in-memory store, plus optional shred seams. */
export function makeService(
  opts: {
    erasabilityResolver?: ErasabilityResolver
    ledger?: ShredLedger
    emitShredded?: (event: SubjectShreddedEvent) => void
    withLock?: CryptoOperationLock
  } = {}
) {
  const store = new InMemoryWrappedDekStore()
  // ledger/emitShredded/withLock are optional-without-undefined on the deps, so
  // include each only when the caller supplied it rather than passing an explicit
  // undefined.
  const service = new CryptoService({
    keyProvider: new EnvKeyProvider(),
    store,
    erasabilityResolver: opts.erasabilityResolver,
    ...(opts.ledger ? { ledger: opts.ledger } : {}),
    ...(opts.emitShredded ? { emitShredded: opts.emitShredded } : {}),
    ...(opts.withLock ? { withLock: opts.withLock } : {}),
  })
  return { service, store }
}

import { test } from '@japa/runner'
import RekekService from '../../../../src/services/rekek_service.js'
import { tenant } from '../../../helpers/crypto_shred_fakes.js'
import type { KeyProvider, WrappedDek } from '../../../../src/types/key_provider.js'
import type {
  ListLiveOptions,
  NewWrappedDekRow,
  WrappedDekRow,
  WrappedDekStore,
} from '../../../../src/services/wrapped_dek_store.js'

const T = tenant('tenant-1')

/** A provider whose current generation is 'new', so a row at 'old' classifies as a re-wrap. */
const rotatingProvider: KeyProvider = {
  name: 'fake',
  async wrapDek(): Promise<WrappedDek> {
    return { kekId: 'new', ciphertext: 'rewrapped' }
  },
  async unwrapDek(): Promise<Buffer> {
    return Buffer.alloc(32)
  },
  async currentKekId(): Promise<string> {
    return 'new'
  },
}

/** A store with one live row at the old generation whose `rewrap` reports it tombstoned nothing. */
function storeShreddedDuringRewrap(): WrappedDekStore {
  const row: WrappedDekRow = {
    id: 'r1',
    subjectId: 's',
    category: 'c',
    wrappedDek: 'w',
    kekId: 'old',
    shreddedAt: null,
  }
  return {
    async listLive(_t, options: ListLiveOptions = {}): Promise<WrappedDekRow[]> {
      return options.afterId ? [] : [row] // one page, then done
    },
    async rewrap(): Promise<boolean> {
      return false // the row was crypto-shredded between the scan and the UPDATE
    },
    async findLive(): Promise<WrappedDekRow | null> {
      return null
    },
    async insert(_t, r: NewWrappedDekRow): Promise<WrappedDekRow> {
      return { ...row, ...r, id: 'x', shreddedAt: null }
    },
    async shredLive(): Promise<boolean> {
      return false
    },
  }
}

// The rekek accounting invariant is exact:
// `scanned === current + rotated + shreddedDuringRewrap + failed`. A row whose
// unwrap+re-wrap succeeded but whose UPDATE tombstoned nothing (it was shredded mid-walk)
// is counted on its own axis, so `current` keeps meaning "already at the target KEK,
// skipped" instead of absorbing an unrelated race.
test.group('crypto rekek: exact accounting under a shred race', () => {
  test('a row shredded during re-wrap is counted as shreddedDuringRewrap, not current', async ({
    assert,
  }) => {
    const rekek = new RekekService({
      keyProvider: rotatingProvider,
      store: storeShreddedDuringRewrap(),
    })
    const summary = await rekek.rekekTenant(T)

    assert.equal(summary.scanned, 1)
    assert.equal(summary.rotated, 0)
    assert.equal(summary.shreddedDuringRewrap, 1)
    assert.equal(summary.current, 0)
    assert.equal(summary.failed, 0)
    // The accounting invariant holds exactly.
    assert.equal(
      summary.current + summary.rotated + summary.shreddedDuringRewrap + summary.failed,
      summary.scanned
    )
  })
})

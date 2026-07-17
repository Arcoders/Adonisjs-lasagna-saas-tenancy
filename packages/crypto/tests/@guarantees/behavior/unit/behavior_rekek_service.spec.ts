import { test } from '@japa/runner'
import { randomBytes, randomUUID } from 'node:crypto'
import { classifyRekek } from '../../../../src/internal/rekek.js'
import RekekService from '../../../../src/services/rekek_service.js'
import InMemoryWrappedDekStore from '../../../../src/testing/in_memory_wrapped_dek_store.js'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { KeyProvider, WrappedDek } from '../../../../src/types/key_provider.js'

/** A fake tenant: the store + provider only read `.id`. */
function tenant(id: string): TenantModelContract {
  return { id } as unknown as TenantModelContract
}

/**
 * A fake KeyProvider whose "wrap" is an identity base64 of the DEK (so a re-wrap
 * preserves the DEK bytes, exactly like a real KEK re-wrap), stamped with the
 * current generation. It can unwrap only the generations it `knows`; an unknown one
 * throws (modelling a DEK wrapped under a KEK generation the provider no longer
 * holds, so the walker records it as `failed`).
 */
class FakeKeyProvider implements KeyProvider {
  readonly name = 'fake'

  /**
   * Present only when the fake reports a rotation cursor, so the walker takes its
   * cursor branch. Assigned in the constructor body on purpose: a class field
   * initializer runs before the constructor assigns the parameter properties, so
   * reading `reportCursor` from one always saw undefined and left this method off
   * the provider entirely.
   */
  readonly currentKekId?: (tenantId: string) => Promise<string>

  constructor(
    private current: string,
    private known: Set<string>,
    reportCursor = true
  ) {
    if (reportCursor) {
      this.currentKekId = async (_tenantId: string): Promise<string> => this.current
    }
  }

  async wrapDek(_tenantId: string, dek: Buffer): Promise<WrappedDek> {
    return { kekId: this.current, ciphertext: dek.toString('base64') }
  }

  async unwrapDek(_tenantId: string, wrapped: WrappedDek): Promise<Buffer> {
    if (!this.known.has(wrapped.kekId)) {
      throw new Error(`fake provider holds no KEK for generation '${wrapped.kekId}'`)
    }
    return Buffer.from(wrapped.ciphertext, 'base64')
  }
}

/** Seed a live wrapped-DEK row at a specific KEK generation. */
async function seed(
  store: InMemoryWrappedDekStore,
  t: TenantModelContract,
  subjectId: string,
  category: string,
  kekId: string
): Promise<string> {
  const row = await store.insert(t, {
    subjectId,
    category,
    wrappedDek: randomBytes(32).toString('base64'),
    kekId,
  })
  return row.id
}

test.group('behavior: KEK rotation (rekek)', () => {
  test('classifyRekek: a row at the current generation is current, else rewrap', ({ assert }) => {
    assert.equal(classifyRekek('gen2', 'gen2'), 'current')
    assert.equal(classifyRekek('gen1', 'gen2'), 'rewrap')
    // No cursor known, so every row is a rewrap candidate (resolved post-hoc).
    assert.equal(classifyRekek('gen2', undefined), 'rewrap')
  })

  test('current / rotate / failed classification in one pass (cursor path)', async ({ assert }) => {
    const t = tenant(randomUUID())
    const store = new InMemoryWrappedDekStore()
    await seed(store, t, 's1', 'identity', 'gen2') // current
    const rotateId = await seed(store, t, 's2', 'identity', 'gen1') // old, so it rotates
    await seed(store, t, 's3', 'identity', 'genX') // unknown, so it fails

    const provider = new FakeKeyProvider('gen2', new Set(['gen1', 'gen2']))
    const summary = await new RekekService({ keyProvider: provider, store }).rekekTenant(t)

    assert.equal(summary.scanned, 3)
    assert.equal(summary.current, 1)
    assert.equal(summary.rotated, 1)
    assert.equal(summary.failed, 1)
    assert.lengthOf(summary.failures, 1)
    assert.equal(summary.failures[0]?.category, 'identity')
    assert.equal(summary.failures[0]?.kekId, 'genX')

    // The rotated row now carries the current generation; its DEK bytes are
    // unchanged (the fake wrap is identity base64), so field data still decrypts.
    const rotated = await store.findLive(t, 's2', 'identity')
    assert.equal(rotated?.id, rotateId)
    assert.equal(rotated?.kekId, 'gen2')
  })

  test('is idempotent: a second pass finds everything current, writes nothing', async ({
    assert,
  }) => {
    const t = tenant(randomUUID())
    const store = new InMemoryWrappedDekStore()
    await seed(store, t, 's1', 'identity', 'gen1')
    await seed(store, t, 's2', 'marketing', 'gen1')
    const provider = new FakeKeyProvider('gen2', new Set(['gen1', 'gen2']))
    const rekek = new RekekService({ keyProvider: provider, store })

    const first = await rekek.rekekTenant(t)
    assert.equal(first.rotated, 2)

    const second = await rekek.rekekTenant(t)
    assert.equal(second.scanned, 2)
    assert.equal(second.current, 2)
    assert.equal(second.rotated, 0)
    assert.equal(second.failed, 0)
  })

  test('dry-run classifies but writes nothing', async ({ assert }) => {
    const t = tenant(randomUUID())
    const store = new InMemoryWrappedDekStore()
    await seed(store, t, 's1', 'identity', 'gen1')
    const provider = new FakeKeyProvider('gen2', new Set(['gen1', 'gen2']))
    const rekek = new RekekService({ keyProvider: provider, store })

    const dry = await rekek.rekekTenant(t, { dryRun: true })
    assert.equal(dry.rotated, 1)
    // Nothing was written: the row is still at the old generation.
    assert.equal((await store.findLive(t, 's1', 'identity'))?.kekId, 'gen1')

    // A real pass then rotates it.
    const real = await rekek.rekekTenant(t)
    assert.equal(real.rotated, 1)
    assert.equal((await store.findLive(t, 's1', 'identity'))?.kekId, 'gen2')
  })

  test('post-hoc classification when the provider reports no cursor', async ({ assert }) => {
    const t = tenant(randomUUID())
    const store = new InMemoryWrappedDekStore()
    await seed(store, t, 's1', 'identity', 'gen2') // already current
    await seed(store, t, 's2', 'identity', 'gen1') // old, so it rotates
    // reportCursor = false, so classifyRekek returns 'rewrap' for both; the walker
    // resolves 'current' post-hoc by comparing the re-wrapped kekId to the row's.
    const provider = new FakeKeyProvider('gen2', new Set(['gen1', 'gen2']), false)
    const summary = await new RekekService({ keyProvider: provider, store }).rekekTenant(t)

    assert.equal(summary.current, 1)
    assert.equal(summary.rotated, 1)
    assert.equal(summary.failed, 0)
  })

  test('walks past the batch size (keyset pagination visits every row once)', async ({
    assert,
  }) => {
    const t = tenant(randomUUID())
    const store = new InMemoryWrappedDekStore()
    for (let i = 0; i < 7; i++) await seed(store, t, `s${i}`, 'identity', 'gen1')
    const provider = new FakeKeyProvider('gen2', new Set(['gen1', 'gen2']))
    const summary = await new RekekService({
      keyProvider: provider,
      store,
      batchSize: 2,
    }).rekekTenant(t)

    assert.equal(summary.scanned, 7)
    assert.equal(summary.rotated, 7)
  })

  test('scopes to one tenant: another tenant’s DEKs are untouched', async ({ assert }) => {
    const store = new InMemoryWrappedDekStore()
    const a = tenant(randomUUID())
    const b = tenant(randomUUID())
    await seed(store, a, 's1', 'identity', 'gen1')
    await seed(store, b, 's1', 'identity', 'gen1')
    const provider = new FakeKeyProvider('gen2', new Set(['gen1', 'gen2']))

    const summary = await new RekekService({ keyProvider: provider, store }).rekekTenant(a)
    assert.equal(summary.scanned, 1)
    // Tenant b was not walked; its row is still at the old generation.
    assert.equal((await store.findLive(b, 's1', 'identity'))?.kekId, 'gen1')
  })
})

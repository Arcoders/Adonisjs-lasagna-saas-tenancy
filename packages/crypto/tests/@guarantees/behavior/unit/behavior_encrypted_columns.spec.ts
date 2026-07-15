import { test } from '@japa/runner'
import { BaseModel } from '@adonisjs/lucid/orm'
import {
  collectModelEncryptionMeta,
  decryptModelFields,
  encrypted,
  encryptModelFields,
  searchable,
  type EncryptableRow,
  type EncryptedFieldsRepo,
  type ModelEncryptionMeta,
} from '../../../../src/models/encrypted_columns.js'

/** A recording fake engine: a reversible "encrypt" so a round-trip can be asserted. */
class FakeRepo implements EncryptedFieldsRepo {
  readonly calls: Array<[string, ...unknown[]]> = []
  async encrypt(subject: string, category: string, value: string): Promise<string> {
    this.calls.push(['encrypt', subject, category, value])
    return `enc_v2:${category}:${subject}:${value}`
  }
  async decrypt(subject: string, category: string, ciphertext: string): Promise<string> {
    this.calls.push(['decrypt', subject, category, ciphertext])
    const m = /^enc_v2:[^:]+:[^:]+:(.*)$/.exec(ciphertext)
    // Match the real engine's strictness (openV2WithKey throws on a non-enc_v2 value)
    // so a double-decrypt of an already-plaintext value fails loudly here too.
    if (!m) throw new Error(`decrypt: value is not enc_v2 ciphertext: '${ciphertext}'`)
    return m[1]
  }
  async blindIndex(
    category: string,
    value: string,
    options?: { caseInsensitive?: boolean }
  ): Promise<string> {
    this.calls.push(['blindIndex', category, value, options])
    return `idx:${category}:${options?.caseInsensitive ? value.toUpperCase() : value}`
  }
}

/** A minimal Lucid-row double: `$attributes` + the two sanctioned mutators. */
function rowDouble(
  attrs: Record<string, unknown>,
  opts: { persisted?: boolean } = {}
): EncryptableRow & { hydrated: number } {
  const $attributes = { ...attrs }
  return {
    $attributes,
    $isPersisted: opts.persisted ?? false,
    hydrated: 0,
    $setAttribute(key: string, value: unknown) {
      $attributes[key] = value
    },
    $hydrateOriginals() {
      this.hydrated++
    },
  }
}

const META: ModelEncryptionMeta = {
  encrypted: [
    {
      column: 'passportNumber',
      category: 'identity-docs',
      subject: (r) => String(r.$attributes.id),
    },
  ],
  searchable: [
    {
      column: 'passportIndex',
      category: 'identity-docs',
      from: (r) => r.$attributes.passportNumber as string | null,
      options: {},
    },
  ],
}

test.group('crypto @encrypted/@searchable: pure hook logic', () => {
  test('encrypts a field and indexes it from the PLAINTEXT source (searchable before encrypt)', async ({
    assert,
  }) => {
    const repo = new FakeRepo()
    const model = rowDouble({ id: 'renter-1', passportNumber: 'AB1234567', passportIndex: null })
    await encryptModelFields(repo, META, model)

    assert.equal(model.$attributes.passportNumber, 'enc_v2:identity-docs:renter-1:AB1234567')
    assert.equal(model.$attributes.passportIndex, 'idx:identity-docs:AB1234567')
    // The blind index was computed from the plaintext, never the ciphertext.
    const idx = repo.calls.find((c) => c[0] === 'blindIndex')
    assert.deepEqual(idx, ['blindIndex', 'identity-docs', 'AB1234567', {}])
  })

  test('a null encrypted value is left untouched (no encrypt call)', async ({ assert }) => {
    const repo = new FakeRepo()
    const model = rowDouble({ id: 'renter-1', passportNumber: null, passportIndex: null })
    await encryptModelFields(repo, META, model)
    assert.isNull(model.$attributes.passportNumber)
    assert.isNull(model.$attributes.passportIndex, 'a null source indexes to null')
    assert.isUndefined(repo.calls.find((c) => c[0] === 'encrypt'))
  })

  test('an already-ciphertext value is not double-encrypted', async ({ assert }) => {
    const repo = new FakeRepo()
    const already = 'enc_v2:identity-docs:renter-1:AB1234567'
    const model = rowDouble({ id: 'renter-1', passportNumber: already, passportIndex: null })
    await encryptModelFields(repo, META, model)
    assert.equal(model.$attributes.passportNumber, already, 'unchanged')
    assert.isUndefined(repo.calls.find((c) => c[0] === 'encrypt'))
  })

  test('decrypts a field in place and re-baselines it (not dirty)', async ({ assert }) => {
    const repo = new FakeRepo()
    const model = rowDouble({
      id: 'renter-1',
      passportNumber: 'enc_v2:identity-docs:renter-1:AB1234567',
    })
    await decryptModelFields(repo, META, model)
    assert.equal(model.$attributes.passportNumber, 'AB1234567')
    assert.equal(model.hydrated, 1, '$hydrateOriginals was called so the load is not dirty')
  })

  test('the searchable index column is never decrypted (it is a plain HMAC)', async ({
    assert,
  }) => {
    const repo = new FakeRepo()
    const model = rowDouble({
      id: 'renter-1',
      passportNumber: 'enc_v2:identity-docs:renter-1:AB1234567',
      passportIndex: 'idx:identity-docs:AB1234567',
    })
    await decryptModelFields(repo, META, model)
    assert.equal(model.$attributes.passportIndex, 'idx:identity-docs:AB1234567', 'untouched')
    assert.isUndefined(
      repo.calls.find((c) => c[0] === 'decrypt' && c[3] === model.$attributes.passportIndex)
    )
  })

  test('fail-closed: an encryption failure propagates so the save aborts', async ({ assert }) => {
    const repo = new FakeRepo()
    repo.encrypt = async () => {
      throw new Error('KeyProvider down')
    }
    const model = rowDouble({ id: 'renter-1', passportNumber: 'AB1234567', passportIndex: null })
    await assert.rejects(() => encryptModelFields(repo, META, model), /KeyProvider down/)
  })

  test('a partial load (persisted row, source column not selected) does NOT clobber the stored index', async ({
    assert,
  }) => {
    const repo = new FakeRepo()
    // Projected load: `passportNumber` was not selected, so it is absent; the row
    // carries the real stored HMAC in `passportIndex`. A save must preserve it.
    const model = rowDouble(
      { id: 'renter-1', passportIndex: 'idx:identity-docs:AB1234567' },
      { persisted: true }
    )
    await encryptModelFields(repo, META, model)
    assert.equal(
      model.$attributes.passportIndex,
      'idx:identity-docs:AB1234567',
      'stored blind index survives a partial-load save'
    )
    assert.isUndefined(
      repo.calls.find((c) => c[0] === 'blindIndex'),
      'no recompute from an absent source'
    )
  })

  test('an EXPLICIT null source on a persisted row still nulls the index (a real clear)', async ({
    assert,
  }) => {
    const repo = new FakeRepo()
    const model = rowDouble(
      { id: 'renter-1', passportNumber: null, passportIndex: 'idx:identity-docs:AB1234567' },
      { persisted: true }
    )
    await encryptModelFields(repo, META, model)
    assert.isNull(model.$attributes.passportIndex, 'clearing the source clears the index')
  })
})

// The decorators are applied functionally here, not with `@` syntax: the esbuild/tsx
// unit runner transforms TC39 decorators (which reject a decorated `declare` field),
// while `tsc` (the build + typecheck) handles the `@` sugar. Applying the same
// decorator functions directly exercises the identical runtime registration; the
// `@` ergonomics are validated by the typecheck.
class DecoratedRenter extends BaseModel {
  declare passportNumber: string | null
  declare passportIndex: string | null
}
encrypted({ category: 'identity-docs', subject: (row: any) => row.id })(
  DecoratedRenter.prototype,
  'passportNumber'
)
searchable({
  category: 'identity-docs',
  from: (row: any) => row.passportNumber,
  caseInsensitive: true,
})(DecoratedRenter.prototype, 'passportIndex')

class PlainModel extends BaseModel {}

test.group('crypto @encrypted/@searchable: decorator metadata', () => {
  test('the decorators record the column mapping on the model', ({ assert }) => {
    const meta = collectModelEncryptionMeta(DecoratedRenter)
    assert.lengthOf(meta.encrypted, 1)
    assert.equal(meta.encrypted[0].column, 'passportNumber')
    assert.equal(meta.encrypted[0].category, 'identity-docs')
    assert.lengthOf(meta.searchable, 1)
    assert.equal(meta.searchable[0].column, 'passportIndex')
    assert.deepEqual(meta.searchable[0].options, { caseInsensitive: true })
  })

  test('a model with no encrypted columns collects empty metadata', ({ assert }) => {
    const meta = collectModelEncryptionMeta(PlainModel)
    assert.deepEqual(meta, { encrypted: [], searchable: [] })
  })
})

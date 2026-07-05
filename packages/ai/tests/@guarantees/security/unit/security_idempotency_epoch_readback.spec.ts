import { test } from '@japa/runner'
import AiIdempotencyService, {
  deriveAiIdempotencyMacKey,
  type AiIdempotencyStore,
} from '../../../../src/gateway/idempotency.js'

/**
 * WS-AI-9 E3: `bumpEpoch` is the fail-closed purge gate. A store that silently
 * no-ops the `set` would leave the old epoch resolving and pre-purge responses
 * replayable, so the rotation is read back and confirmed. This spec proves the
 * gate throws when the write is not observable, and succeeds when it is — the
 * bite the whole "bumpEpoch first" ordering depends on.
 */

const TENANT = '11111111-1111-4111-8111-111111110001'
const macKey = deriveAiIdempotencyMacKey('test-app-key')

test.group('security — idempotency epoch read-back (WS-AI-9 E3)', () => {
  test('bumpEpoch confirms the rotation against a healthy store', async ({ assert }) => {
    const data = new Map<string, string>()
    const store: AiIdempotencyStore = {
      async get(_t, key) {
        return data.get(key)
      },
      async set(_t, key, value) {
        data.set(key, value)
      },
    }
    const svc = new AiIdempotencyService({ store, macKey })
    await svc.bumpEpoch(TENANT) // resolves: the read-back matches the value written
    assert.isTrue(data.has('ai:idem:epoch'))
  })

  test('bumpEpoch THROWS when the store silently no-ops the set', async ({ assert }) => {
    const store: AiIdempotencyStore = {
      async get() {
        return undefined // never reflects the write
      },
      async set() {
        // silent no-op: resolves without persisting
      },
    }
    const svc = new AiIdempotencyService({ store, macKey })
    await assert.rejects(() => svc.bumpEpoch(TENANT), /did not rotate verifiably/)
  })

  test('bumpEpoch propagates a hard store outage (set throws)', async ({ assert }) => {
    const store: AiIdempotencyStore = {
      async get() {
        return undefined
      },
      async set() {
        throw new Error('redis down')
      },
    }
    const svc = new AiIdempotencyService({ store, macKey })
    await assert.rejects(() => svc.bumpEpoch(TENANT), /redis down/)
  })
})

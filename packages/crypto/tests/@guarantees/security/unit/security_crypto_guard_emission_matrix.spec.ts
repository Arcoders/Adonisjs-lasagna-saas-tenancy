import { test } from '@japa/runner'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import { ISTHMUS_BUDGETS } from '@adonisjs-lasagna/saas-tenancy/sdk'
import {
  CRYPTO_GUARD_REJECTIONS_METRIC,
  emitCryptoGuardEvent,
  setCryptoGuardMetricSink,
  snapshotCryptoGuardCounters,
  __resetCryptoGuardCounters,
  __resetCryptoGuardRateLimit,
  __setCryptoGuardDispatcherForTests,
} from '../../../../src/isthmus/crypto_guard_audit.js'
import {
  CRYPTO_GUARD_REGISTRY,
  type CryptoGuardId,
} from '../../../../src/isthmus/crypto_guard_registry.js'
import CryptoService from '../../../../src/services/crypto_service.js'
import EnvKeyProvider from '../../../../src/services/env_key_provider.js'
import InMemoryWrappedDekStore from '../../../../src/testing/in_memory_wrapped_dek_store.js'
import PgWrappedDekStore from '../../../../src/services/pg_wrapped_dek_store.js'
import { assertCryptoConfig } from '../../../../src/validate_config.js'
import type { CryptoConfig } from '../../../../src/define_config.js'
import type { KeyProvider } from '../../../../src/types/key_provider.js'
import {
  erasable,
  makeService,
  notErasable,
  RecordingLedger,
  tenant,
} from '../../../helpers/crypto_shred_fakes.js'

/**
 * The registry-driven crypto guard emission matrix, mirroring the kernel's and AI's.
 * Every registered guard must, when tripped, emit its own event (exactly once) with a
 * payload that mirrors its registry entry, and must not emit on a happy input.
 * Completeness is pinned both ways so a new guard cannot ship without a behavioral
 * test: the matrix is typed `Record<CryptoGuardId, TripRecipe>` (a new registry entry
 * is a compile error here until it gets a recipe), and every matrix key must be a real
 * registry id.
 */

const TEST_KEY = 'crypto-emission-matrix-app-key'
const T = tenant('tenant-1')
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

interface TripRecipe {
  /** Trips the guard; sync or async. Throws the guard's own exception, unless expectThrow is null. */
  trip: () => unknown | Promise<unknown>
  /** The unchanged exception's message must match this (all crypto guards throw). */
  expectThrow: RegExp | null
  /** A happy input that must not emit. */
  happy: () => unknown | Promise<unknown>
}

/** A KeyProvider whose unwrap always fails (KMS down), used to trip dek_unwrap_failed. */
const failingUnwrapProvider = {
  name: 'fake-kms',
  async wrapDek() {
    return { kekId: 'kek-1', ciphertext: 'enc_v2:tag:iv:ct:more' }
  },
  async unwrapDek() {
    throw new Error('kms down')
  },
} as unknown as KeyProvider

/** Working schema-pg fakes for the scope-match happy path (never reached on a mismatch). */
const okDriver = {
  name: 'schema-pg',
  tableLocation: () => ({ kind: 'schema', schema: 's', connectionName: 'c' }),
}
const okDb = { connection: () => ({ rawQuery: async () => ({ rows: [] }) }) }

const TRIP_MATRIX: Record<CryptoGuardId, TripRecipe> = {
  'guard.crypto_dek_unwrap_failed': {
    trip: async () => {
      const store = new InMemoryWrappedDekStore()
      const svc = new CryptoService({ keyProvider: failingUnwrapProvider, store })
      const ct = await svc.encryptField(T, 'subject-1', 'identity-docs', 'secret')
      return svc.decryptField(T, 'subject-1', 'identity-docs', ct)
    },
    expectThrow: /kms down/,
    happy: async () => {
      const { service } = makeService()
      const ct = await service.encryptField(T, 'subject-1', 'identity-docs', 'secret')
      return service.decryptField(T, 'subject-1', 'identity-docs', ct)
    },
  },
  'guard.crypto_shred_legal_hold': {
    trip: async () => {
      const { service } = makeService({ erasabilityResolver: notErasable() })
      await service.encryptField(T, 'subject-1', 'identity-docs', 'secret')
      return service.shred(T, 'subject-1', 'identity-docs')
    },
    expectThrow: /not erasable/,
    happy: async () => {
      const { service } = makeService({
        erasabilityResolver: erasable(),
        ledger: new RecordingLedger(),
      })
      await service.encryptField(T, 'subject-1', 'identity-docs', 'secret')
      return service.shred(T, 'subject-1', 'identity-docs')
    },
  },
  'guard.crypto_shred_unaudited': {
    trip: async () => {
      const { service } = makeService({ erasabilityResolver: erasable() }) // no ledger
      await service.encryptField(T, 'subject-1', 'identity-docs', 'secret')
      return service.shred(T, 'subject-1', 'identity-docs')
    },
    expectThrow: /unaudited/,
    happy: async () => {
      const { service } = makeService({
        erasabilityResolver: erasable(),
        ledger: new RecordingLedger(),
      })
      await service.encryptField(T, 'subject-1', 'identity-docs', 'secret')
      return service.shred(T, 'subject-1', 'identity-docs')
    },
  },
  'guard.crypto_keyprovider_unavailable': {
    trip: () => {
      const saved = process.env.APP_KEY
      delete process.env.APP_KEY
      try {
        return new EnvKeyProvider().currentKekId('tenant-1')
      } finally {
        if (saved !== undefined) process.env.APP_KEY = saved
      }
    },
    expectThrow: /APP_KEY is not set/,
    happy: () => new EnvKeyProvider().currentKekId('tenant-1'),
  },
  'guard.crypto_config_invalid': {
    trip: () => assertCryptoConfig({ keyProvider: '' } as unknown as CryptoConfig),
    expectThrow: /non-empty backend name/,
    happy: () => assertCryptoConfig({ keyProvider: 'env' } as CryptoConfig),
  },
  'guard.crypto_scope_mismatch': {
    trip: () => {
      const store = new PgWrappedDekStore({
        getDriver: async () => {
          throw new Error('the scope seal must reject before the driver')
        },
        getDb: async () => {
          throw new Error('the scope seal must reject before the db')
        },
        activeScopeTenantId: () => 'someone-else',
      })
      return store.findLive(T, 'subject-1', 'identity-docs')
    },
    expectThrow: /does not match the active tenancy scope/,
    happy: () => {
      const store = new PgWrappedDekStore({
        getDriver: async () => okDriver as never,
        getDb: async () => okDb as never,
        activeScopeTenantId: () => 'tenant-1',
      })
      return store.findLive(T, 'subject-1', 'identity-docs')
    },
  },
}

function registryIds(): CryptoGuardId[] {
  return CRYPTO_GUARD_REGISTRY.map((e) => e.id)
}

test.group('crypto guard emission matrix: completeness', () => {
  test('every registry id has a matrix entry', ({ assert }) => {
    const missing = registryIds().filter((id) => !(id in TRIP_MATRIX))
    assert.deepEqual(missing, [], `guards with no behavioral test: ${missing.join(', ')}`)
  })

  test('every matrix key is a real registry id', ({ assert }) => {
    const ids = new Set<string>(registryIds())
    const stray = Object.keys(TRIP_MATRIX).filter((id) => !ids.has(id))
    assert.deepEqual(stray, [], `matrix keys not in the registry: ${stray.join(', ')}`)
  })
})

test.group('crypto guard emission matrix: trip and happy', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []
  let savedAppKey: string | undefined

  group.each.setup(() => {
    savedAppKey = process.env.APP_KEY
    process.env.APP_KEY = TEST_KEY
    captured = []
    __resetCryptoGuardCounters()
    __resetCryptoGuardRateLimit()
    __setCryptoGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setCryptoGuardDispatcherForTests(undefined)
    setCryptoGuardMetricSink(undefined)
    __resetCryptoGuardCounters()
    __resetCryptoGuardRateLimit()
    if (savedAppKey === undefined) delete process.env.APP_KEY
    else process.env.APP_KEY = savedAppKey
  })

  for (const id of Object.keys(TRIP_MATRIX) as CryptoGuardId[]) {
    const recipe = TRIP_MATRIX[id]
    const entry = CRYPTO_GUARD_REGISTRY.find((e) => e.id === id)!

    test(`${id}: tripping emits exactly one matching event, unchanged exception`, async ({
      assert,
    }) => {
      let threw: unknown
      try {
        await recipe.trip()
      } catch (err) {
        threw = err
      }
      await settle()

      assert.isDefined(threw, `${id}: trip recipe did not throw`)
      if (recipe.expectThrow) {
        assert.match(
          (threw as Error).message,
          recipe.expectThrow,
          `${id}: exception message changed`
        )
      }

      assert.lengthOf(captured, 1, `${id}: expected exactly one dispatch`)
      assert.equal(captured[0].id, id)
      assert.equal(captured[0].severity, entry.severity)
      assert.equal(captured[0].event, entry.event)
      assert.equal(captured[0].pillar, 'guard')

      const snapshot = snapshotCryptoGuardCounters()
      assert.equal(
        snapshot.rejected.find((r) => r.id === id)?.value ?? 0,
        1,
        `${id}: rejected delta must be exactly 1`
      )
    })

    test(`${id}: a happy input emits nothing`, async ({ assert }) => {
      await recipe.happy()
      await settle()

      assert.lengthOf(captured, 0, `${id}: happy input must not emit`)
      const snapshot = snapshotCryptoGuardCounters()
      assert.lengthOf(snapshot.rejected, 0, `${id}: happy input must not bump rejected`)
    })
  }
})

test.group('crypto guard audit: budgets, drops and the metric bridge', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

  group.each.setup(() => {
    captured = []
    __resetCryptoGuardCounters()
    __resetCryptoGuardRateLimit()
    __setCryptoGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })

  group.each.teardown(() => {
    __setCryptoGuardDispatcherForTests(undefined)
    setCryptoGuardMetricSink(undefined)
    __resetCryptoGuardCounters()
    __resetCryptoGuardRateLimit()
  })

  test('counters keep exact totals when the per-severity budget drops dispatches', async ({
    assert,
  }) => {
    // guard.crypto_config_invalid is severity warn; one over budget in one window.
    const budget = ISTHMUS_BUDGETS.warn
    for (let i = 0; i <= budget; i++) {
      try {
        assertCryptoConfig({ keyProvider: '' } as unknown as CryptoConfig)
      } catch {
        // The guard's own throw; the emission is what this test observes.
      }
    }
    await settle()

    assert.lengthOf(captured, budget, 'dispatches must stop at the window budget')
    const snapshot = snapshotCryptoGuardCounters()
    assert.equal(
      snapshot.rejected.find((r) => r.id === 'guard.crypto_config_invalid')?.value,
      budget + 1,
      'rejected counts every trip, dropped or not'
    )
    assert.deepEqual(
      snapshot.dropped,
      [{ severity: 'warn', reason: 'rate_limited', value: 1 }],
      'the over-budget dispatch is a counted drop'
    )
  })

  test('an async-rejecting dispatcher lands in dropped{no_emitter}', async ({ assert }) => {
    __setCryptoGuardDispatcherForTests(async () => {
      throw new Error('listener exploded')
    })
    emitCryptoGuardEvent('guard.crypto_scope_mismatch', { tenantId: 'tenant-1' })
    await settle()

    assert.deepEqual(snapshotCryptoGuardCounters().dropped, [
      { severity: 'critical', reason: 'no_emitter', value: 1 },
    ])
  })

  test('a SYNCHRONOUSLY-throwing dispatcher is still a counted drop, not an escape', async ({
    assert,
  }) => {
    __setCryptoGuardDispatcherForTests(((): Promise<void> => {
      throw new Error('sync boom')
    }) as unknown as Parameters<typeof __setCryptoGuardDispatcherForTests>[0])

    assert.doesNotThrow(() =>
      emitCryptoGuardEvent('guard.crypto_scope_mismatch', { tenantId: 'tenant-1' })
    )
    await settle()

    assert.deepEqual(snapshotCryptoGuardCounters().dropped, [
      { severity: 'critical', reason: 'no_emitter', value: 1 },
    ])
  })

  test('the default dispatcher degrades to a counted drop in a bare runner', async ({ assert }) => {
    __setCryptoGuardDispatcherForTests(undefined)
    assert.doesNotThrow(() =>
      emitCryptoGuardEvent('guard.crypto_scope_mismatch', { tenantId: 'tenant-1' })
    )
    for (let i = 0; i < 200 && snapshotCryptoGuardCounters().dropped.length === 0; i++) {
      await settle()
    }
    assert.deepEqual(snapshotCryptoGuardCounters().dropped, [
      { severity: 'critical', reason: 'no_emitter', value: 1 },
    ])
  })

  test('a tenantful trip bridges exactly one crypto_guard_rejections metric', async ({
    assert,
  }) => {
    const metrics: Array<{ tenantId: string; name: string; value: number }> = []
    setCryptoGuardMetricSink((tenantId, name, value) => {
      metrics.push({ tenantId, name, value })
    })
    emitCryptoGuardEvent('guard.crypto_scope_mismatch', { tenantId: 'tenant-1' })
    await settle()

    assert.deepEqual(metrics, [
      { tenantId: 'tenant-1', name: CRYPTO_GUARD_REJECTIONS_METRIC, value: 1 },
    ])
  })

  test('a tenant-less trip never reaches the metric sink', async ({ assert }) => {
    const metrics: unknown[] = []
    setCryptoGuardMetricSink((...call) => {
      metrics.push(call)
    })
    emitCryptoGuardEvent('guard.crypto_config_invalid')
    await settle()

    assert.lengthOf(metrics, 0, 'config and boot guards are tenant-less by design')
  })

  test('a synchronously-throwing metric sink cannot break the reject path or the event', async ({
    assert,
  }) => {
    setCryptoGuardMetricSink(() => {
      throw new Error('metrics backend down')
    })
    assert.doesNotThrow(() =>
      emitCryptoGuardEvent('guard.crypto_scope_mismatch', { tenantId: 'tenant-1' })
    )
    await settle()

    assert.lengthOf(captured, 1, 'the event still dispatches when the metric sink fails')
  })
})

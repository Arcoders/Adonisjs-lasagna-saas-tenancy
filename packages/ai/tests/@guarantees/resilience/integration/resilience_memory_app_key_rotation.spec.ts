import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import { randomUUID } from 'node:crypto'
import ConversationMemoryService, {
  AI_MEMORY_DECRYPT_PREVIOUS_METRIC,
  AI_MEMORY_UNDECRYPTABLE_METRIC,
  type ConversationMemoryDeps,
} from '../../../../src/services/conversation_memory_service.js'

/**
 * APP_KEY rotation for enc_v2 conversation memory, on REAL Redis.
 * A turn written under the OLD key is still readable during the grace window via
 * `decryptMemoryPrevious` (and that read is signalled by the previous-key metric);
 * once the grace key is gone, the turn is dropped fail-SAFE AND the
 * `ai_memory_undecryptable` metric fires, so a botched rotation that silently drops
 * every historical turn is visible to operators, not just warn-logged. Self-skips
 * when Redis is unavailable, runs in CI.
 */
let ready = false

const MAC = Buffer.alloc(32, 5)
// Async + tenant-scoped fakes (the Wave-5 seam signature); these fakes ignore the tenant id.
const oldEnc = async (_tenantId: string, plain: string) => `old:${plain}`
const oldDec = async (_tenantId: string, cipher: string) => {
  if (!cipher.startsWith('old:')) throw new Error('not old-key ciphertext')
  return cipher.slice(4)
}
// The CURRENT key after rotation: it cannot read an `old:` blob.
const newEnc = async (_tenantId: string, plain: string) => `new:${plain}`
const newDec = async (_tenantId: string, cipher: string) => {
  if (!cipher.startsWith('new:')) throw new Error('not current-key ciphertext')
  return cipher.slice(4)
}

function service(
  extra: Partial<ConversationMemoryDeps>,
  metrics: string[]
): ConversationMemoryService {
  return new ConversationMemoryService({
    getRedis: () => app.container.make('redis'),
    macKey: MAC,
    encryptMemory: newEnc,
    decryptMemory: newDec,
    config: { maxTurns: 5, ttlMs: 60_000 },
    metric: (_tenantId, name) => metrics.push(name),
    ...extra,
  })
}

test.group(
  'memory APP_KEY rotation dual-key read + silent-drop telemetry (T4, real Redis)',
  (group) => {
    group.setup(async () => {
      try {
        const redis = (await app.container.make('redis')) as { ping: () => Promise<unknown> }
        await redis.ping()
        ready = true
      } catch {
        ready = false
      }
    })

    test('a turn under the old key reads via the grace key, then drops with the H1 metric once the grace is gone', async ({
      assert,
    }) => {
      const tenantId = randomUUID()
      // Write a turn under the OLD key (simulate pre-rotation history).
      const writeMetrics: string[] = []
      const svcOld = service({ encryptMemory: oldEnc, decryptMemory: oldDec }, writeMetrics)
      const { storageKey } = svcOld.mintSession(tenantId, 'user-a')

      try {
        await svcOld.append(tenantId, storageKey, { user: 'q-old', assistant: 'a-old' })

        // Grace window: current key can't read it, but the previous key can.
        const graceMetrics: string[] = []
        const svcGrace = service({ decryptMemoryPrevious: oldDec }, graceMetrics)
        assert.deepEqual(await svcGrace.load(tenantId, storageKey), [
          { role: 'user', content: 'q-old' },
          { role: 'assistant', content: 'a-old' },
        ])
        assert.include(
          graceMetrics,
          AI_MEMORY_DECRYPT_PREVIOUS_METRIC,
          'the grace-key read is signalled'
        )

        // Grace expired: no previous key. The turn drops fail-safe AND the undecryptable metric fires.
        const droppedMetrics: string[] = []
        const svcNoGrace = service({}, droppedMetrics)
        assert.lengthOf(
          await svcNoGrace.load(tenantId, storageKey),
          0,
          'an undecryptable turn is dropped, not thrown'
        )
        assert.include(
          droppedMetrics,
          AI_MEMORY_UNDECRYPTABLE_METRIC,
          'H1: the silent drop is now observable as a metric, not only a warn'
        )
      } finally {
        await svcOld.purgeTenant(tenantId)
      }
    }).skip(() => !ready, 'redis not available; runs in CI')
  }
)

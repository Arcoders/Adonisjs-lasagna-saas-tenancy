import { test } from '@japa/runner'
import AiAuditWriter, {
  type AuditAnchorDestination,
  type AuditAnchorRegistry,
} from '../../../../src/services/ai_audit_writer.js'
import type { AuditLogEntry } from '@adonisjs-lasagna/saas-tenancy/services'
import { fakeAuditEnv, sampleAuditRow } from '../../../helpers/fake_audit_db.js'

/** A runExtension double that just runs the fn (no real timeout, for unit speed). */
const runNow = <T>(fn: () => Promise<T>) => fn()

function registryOf(...destinations: AuditAnchorDestination[]): AuditAnchorRegistry {
  return { list: () => destinations }
}

test.group('behavior — AI audit anchoring is best-effort', () => {
  test('a throwing destination is isolated; the canonical append still resolves', async ({
    assert,
  }) => {
    const env = fakeAuditEnv()
    const writer = new AiAuditWriter({
      ...env.deps,
      getDestinations: async () =>
        registryOf({
          name: 'siem',
          write() {
            throw new Error('siem down')
          },
        }),
      runExtension: runNow,
    })
    const entry = await writer.append(sampleAuditRow())
    assert.equal(entry.seq, 1)
    assert.lengthOf(env.inserts, 1)
  })

  test('a working destination receives the mapped non-PII kernel AuditLogEntry', async ({
    assert,
  }) => {
    const received: AuditLogEntry[] = []
    const env = fakeAuditEnv()
    const writer = new AiAuditWriter({
      ...env.deps,
      getDestinations: async () =>
        registryOf({
          name: 'siem',
          write(entry) {
            received.push(entry)
          },
        }),
      runExtension: runNow,
    })
    await writer.append(sampleAuditRow({ principalHash: 'a'.repeat(64) }))
    assert.lengthOf(received, 1)
    assert.equal(received[0].action, 'ai:chat')
    assert.equal(received[0].actorType, 'system')
    assert.equal(received[0].actorId, 'a'.repeat(64))
    assert.isNull(received[0].ipAddress)
    assert.equal((received[0].metadata as Record<string, unknown>).op, 'chat')
    assert.exists((received[0].metadata as Record<string, unknown>).checksum)
    assert.notInclude(JSON.stringify(received[0]), 'user-')
  })

  test('no destinations registered means no fan-out (the default path is free)', async ({
    assert,
  }) => {
    let ran = 0
    const env = fakeAuditEnv()
    const writer = new AiAuditWriter({
      ...env.deps,
      getDestinations: async () => registryOf(),
      runExtension: <T>(fn: () => Promise<T>) => {
        ran += 1
        return fn()
      },
    })
    await writer.append(sampleAuditRow())
    assert.equal(ran, 0)
  })

  test('a resolution failure never fails the request', async ({ assert }) => {
    const env = fakeAuditEnv()
    const writer = new AiAuditWriter({
      ...env.deps,
      getDestinations: async () => {
        throw new Error('container down')
      },
      runExtension: runNow,
    })
    const entry = await writer.append(sampleAuditRow())
    assert.equal(entry.seq, 1)
  })
})

import { test } from '@japa/runner'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import ConversationMemoryService from '../../../../src/services/conversation_memory_service.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import { FakeRedisLists } from '../../../helpers/fake_redis_lists.js'

/**
 * Per-user, per-tenant memory isolation. A session token is
 * HMAC-bound to (tenant, principal); a forged, cross-user or cross-tenant token
 * cannot verify, so it can never reach another principal's memory. The refusal
 * is a fail-closed 400 that trips guard.ai_memory_session_invalid.
 */

const MAC = Buffer.alloc(32, 3)
const T1 = '11111111-1111-4111-8111-1111111111a1'
const T2 = '11111111-1111-4111-8111-1111111111b2'

const svc = () =>
  new ConversationMemoryService({
    getRedis: async () => new FakeRedisLists(),
    macKey: MAC,
    encryptMemory: (p) => p,
    decryptMemory: (c) => c,
    config: { maxTurns: 5 },
  })

test.group('security — memory session isolation', () => {
  test('a valid token round-trips to its own storage key', ({ assert }) => {
    const m = svc()
    const minted = m.mintSession(T1, 'user-a')
    assert.equal(m.resolveSession(minted.token, T1, 'user-a').storageKey, minted.storageKey)
  })

  test('a tampered token is refused with a 400 memory_session_invalid', ({ assert }) => {
    const m = svc()
    const minted = m.mintSession(T1, 'user-a')
    const [sid] = minted.token.split('.')
    const forged = `${sid}.${'0'.repeat(64)}` // wrong MAC

    const error = assert.throws(() => m.resolveSession(forged, T1, 'user-a'))
    assert.instanceOf(error, AIException)
    assert.equal((error as unknown as AIException).aiCode, 'memory_session_invalid')
    assert.equal((error as unknown as AIException).httpStatus, 400)
  })

  test("a principal cannot replay another principal's token (G6)", ({ assert }) => {
    const m = svc()
    const minted = m.mintSession(T1, 'user-a')
    assert.throws(
      () => m.resolveSession(minted.token, T1, 'user-b'),
      /session token does not verify/
    )
  })

  test('the same sid cannot cross tenants; per-tenant keys are disjoint', ({ assert }) => {
    const m = svc()
    const a = m.mintSession(T1, 'user-a')
    const b = m.mintSession(T2, 'user-a')
    assert.notEqual(a.storageKey, b.storageKey, 'same principal, different tenant => disjoint keys')
    // Tenant A's token, presented under tenant B, cannot verify.
    assert.throws(() => m.resolveSession(a.token, T2, 'user-a'), /does not verify/)
  })

  test('the storage key is derived, not the client token (bearer-credential separation)', ({
    assert,
  }) => {
    const m = svc()
    const minted = m.mintSession(T1, 'user-a')
    assert.notEqual(minted.storageKey, minted.token)
    assert.notInclude(minted.storageKey, minted.token)
  })
})

test.group('security — memory session guard emission', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

  group.each.setup(() => {
    captured = []
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
    __setAiGuardDispatcherForTests(async (payload) => {
      captured.push(payload)
    })
  })
  group.each.teardown(() => {
    __setAiGuardDispatcherForTests(undefined)
    __resetAiGuardCounters()
    __resetAiGuardRateLimit()
  })

  test('a forged token trips guard.ai_memory_session_invalid with the tenant id', async ({
    assert,
  }) => {
    const m = svc()
    try {
      m.resolveSession('deadbeef.deadbeef', T1, 'user-a')
    } catch {
      // the guard's own throw
    }
    await settle()
    assert.lengthOf(captured, 1)
    assert.equal(captured[0]!.id, 'guard.ai_memory_session_invalid')
    assert.equal(captured[0]!.severity, 'high')
    assert.equal(captured[0]!.tenantId, T1)
  })
})

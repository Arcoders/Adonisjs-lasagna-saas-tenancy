import { test } from '@japa/runner'
import { ImpersonationService, getCache } from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { LogActionOptions } from '@adonisjs-lasagna/saas-tenancy/services'

const SECRET = 'a'.repeat(64)

class FakeAuditLog {
  calls: LogActionOptions[] = []
  async log(opts: LogActionOptions): Promise<any> {
    this.calls.push(opts)
    return { id: `fake-${this.calls.length}` }
  }
}

/**
 * S1-4: full impersonation lifecycle against the real BentoCache → Redis
 * stack. The unit spec only covers token format/signature; this one
 * exercises start → verify → first-use audit → revoke → expire and
 * proves each transition flips verify() correctly.
 */
test.group('ImpersonationService — lifecycle (integration)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>

  group.each.setup(() => {
    originalConfig = getConfig()
    setConfig({ ...originalConfig, impersonation: { secret: SECRET, defaultDuration: 300 } })
  })

  group.each.teardown(() => {
    setConfig(originalConfig)
  })

  function makeSvc() {
    const audit = new FakeAuditLog()
    const svc = new ImpersonationService({ auditLog: audit as any })
    return { svc, audit }
  }

  const baseStart = {
    tenantId: '11111111-1111-4111-8111-111111111111',
    targetUserId: 'user-42',
    adminId: 'admin-1',
    reason: 'support-ticket-9',
    ipAddress: '203.0.113.5',
  }

  test('start() returns a usable token and seeds an audit entry', async ({ assert }) => {
    const { svc, audit } = makeSvc()
    const result = await svc.start(baseStart)

    assert.isString(result.token)
    assert.match(result.token, /^[a-f0-9]+\.[a-f0-9]+$/)
    assert.equal(result.token.split('.')[0], result.sessionId)
    assert.isAtLeast(result.expiresAt, Date.now() + 280_000) // ~ 300s minus skew

    assert.lengthOf(audit.calls, 1)
    assert.equal(audit.calls[0]!.action, 'admin:impersonate:start')
    assert.equal(audit.calls[0]!.metadata?.sessionId, result.sessionId)
    assert.equal(audit.calls[0]!.metadata?.targetUserId, baseStart.targetUserId)
  })

  test('verify() on a fresh token returns the public context', async ({ assert }) => {
    const { svc } = makeSvc()
    const { token, sessionId } = await svc.start(baseStart)

    const ctx = await svc.verify(token)
    assert.isNotNull(ctx)
    assert.equal(ctx!.sessionId, sessionId)
    assert.equal(ctx!.tenantId, baseStart.tenantId)
    assert.equal(ctx!.userId, baseStart.targetUserId)
    assert.equal(ctx!.adminId, baseStart.adminId)
    assert.equal(ctx!.adminType, 'admin')
  })

  test('verify() emits a first-use audit row exactly once', async ({ assert }) => {
    const { svc, audit } = makeSvc()
    const { token } = await svc.start(baseStart)

    await svc.verify(token)
    await svc.verify(token)
    await svc.verify(token)

    const firstUseRows = audit.calls.filter((c) => c.action === 'admin:impersonate:first-use')
    assert.lengthOf(firstUseRows, 1, 'first-use must be emitted exactly once across verifies')
  })

  test('stop() invalidates the token — subsequent verify returns null', async ({ assert }) => {
    const { svc, audit } = makeSvc()
    const { token } = await svc.start(baseStart)

    assert.isNotNull(await svc.verify(token), 'token works before stop')

    const stopped = await svc.stop(token, { ipAddress: '203.0.113.6' })
    assert.isTrue(stopped)
    assert.isNull(await svc.verify(token), 'token must not work after stop')

    const stopRows = audit.calls.filter((c) => c.action === 'admin:impersonate:stop')
    assert.lengthOf(stopRows, 1)
    assert.equal(stopRows[0]!.ipAddress, '203.0.113.6')
  })

  test('stop() is idempotent — second call returns false silently', async ({ assert }) => {
    const { svc } = makeSvc()
    const { token } = await svc.start(baseStart)
    assert.isTrue(await svc.stop(token))
    assert.isFalse(await svc.stop(token), 'second stop must be a no-op')
  })

  test('revokeById() invalidates the session by raw id', async ({ assert }) => {
    const { svc } = makeSvc()
    const { token, sessionId } = await svc.start(baseStart)

    assert.isTrue(await svc.revokeById(sessionId))
    assert.isNull(await svc.verify(token))
    assert.isFalse(await svc.revokeById(sessionId), 'revokeById is idempotent')
  })

  // SECURITY (#13): revokeById must audit symmetrically with stop(), otherwise a
  // session ended via admin tooling shows a start/first-use with no end and the
  // trail can't prove WHEN impersonation access stopped.
  test('revokeById() writes an attributed admin:impersonate:stop audit row', async ({ assert }) => {
    const { svc, audit } = makeSvc()
    const { sessionId } = await svc.start(baseStart)

    await svc.revokeById(sessionId)

    const stopRows = audit.calls.filter((c) => c.action === 'admin:impersonate:stop')
    assert.lengthOf(stopRows, 1, 'exactly one stop row for the revoked session')
    assert.equal(stopRows[0]!.actorId, baseStart.adminId, 'attributed to the acting admin')
    assert.equal((stopRows[0]!.metadata as any)?.targetUserId, baseStart.targetUserId)
    assert.equal((stopRows[0]!.metadata as any)?.via, 'revoke-by-id')
  })

  test('revokeById() on a missing session writes NO stop row', async ({ assert }) => {
    const { svc, audit } = makeSvc()
    await svc.revokeById('does-not-exist')
    assert.lengthOf(
      audit.calls.filter((c) => c.action === 'admin:impersonate:stop'),
      0
    )
  })

  test('revokeById() returns false for a non-existent session', async ({ assert }) => {
    const { svc } = makeSvc()
    assert.isFalse(await svc.revokeById('00000000000000000000000000000000'))
  })

  test('expired sessions verify as null even before cache TTL fires', async ({ assert }) => {
    const { svc } = makeSvc()
    const { token, sessionId } = await svc.start(baseStart)

    // Force-shift the stored session's expiresAt into the past. This
    // simulates clock drift or a long-lived cache entry that outlives
    // the explicit expiration check in verify().
    const ns = getCache().namespace('impersonation')
    const stored = (await ns.get({ key: sessionId })) as any
    assert.isNotNull(stored, 'session must be in cache after start()')
    stored.expiresAt = Date.now() - 1000
    await ns.set({ key: sessionId, value: stored, ttl: 60_000 })

    assert.isNull(
      await svc.verify(token),
      'verify() must reject sessions whose expiresAt is past, regardless of cache TTL'
    )
  })

  test('verify() on a tampered token returns null', async ({ assert }) => {
    const { svc } = makeSvc()
    const { token } = await svc.start(baseStart)

    // Flip a hex digit in the signature.
    const [sid, sig] = token.split('.') as [string, string]
    const flipped = sig[0] === '0' ? '1' + sig.slice(1) : '0' + sig.slice(1)
    const tampered = `${sid}.${flipped}`

    assert.isNull(await svc.verify(tampered))
  })

  test('start() rejects unsafe targetUserId / adminId values', async ({ assert }) => {
    const { svc } = makeSvc()
    await assert.rejects(
      () => svc.start({ ...baseStart, targetUserId: '../../../etc/passwd' }),
      /targetUserId/
    )
    await assert.rejects(() => svc.start({ ...baseStart, adminId: 'admin\x00' }), /adminId/)
  })

  test('duration is clamped to [60, maxDuration]', async ({ assert }) => {
    const { svc } = makeSvc()
    const before = Date.now()

    const tiny = await svc.start({ ...baseStart, durationSeconds: 1 })
    assert.isAtLeast(tiny.expiresAt - before, 60_000 - 100)

    const huge = await svc.start({ ...baseStart, durationSeconds: 999_999 })
    // Default max is 24h
    assert.isAtMost(huge.expiresAt - before, 24 * 60 * 60 * 1000 + 100)
  })
})

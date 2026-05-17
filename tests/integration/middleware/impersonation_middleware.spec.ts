import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import {
  ImpersonationService,
  getCache,
} from '@adonisjs-lasagna/saas-tenancy/services'
import { getConfig, setConfig } from '@adonisjs-lasagna/saas-tenancy'
import type { LogActionOptions } from '@adonisjs-lasagna/saas-tenancy/services'

const SECRET = 'b'.repeat(64)

class FakeAuditLog {
  calls: LogActionOptions[] = []
  async log(opts: LogActionOptions): Promise<any> {
    this.calls.push(opts)
    return { id: `fake-${this.calls.length}` }
  }
}

// Proves ImpersonationMiddleware wiring under the real HTTP lifecycle
// (fixture exposes /impersonation-check). Sessions land in real Redis
// via BentoCache; each test swaps a fresh service so the audit log is
// observable and isolated.
test.group('ImpersonationMiddleware (integration, HTTP + real Redis)', (group) => {
  let originalConfig: ReturnType<typeof getConfig>
  let originalService: ImpersonationService

  group.each.setup(async () => {
    originalConfig = getConfig()
    setConfig({ ...originalConfig, impersonation: { secret: SECRET, defaultDuration: 300 } })

    originalService = await app.container.make(ImpersonationService)
    const audit = new FakeAuditLog()
    const fresh = new ImpersonationService({ auditLog: audit as any })
    app.container.singleton(ImpersonationService, () => fresh)
    ;(fresh as any).__audit = audit
  })

  group.each.teardown(async () => {
    setConfig(originalConfig)
    app.container.singleton(ImpersonationService, () => originalService)
  })

  async function getSvc(): Promise<ImpersonationService & { __audit: FakeAuditLog }> {
    return (await app.container.make(ImpersonationService)) as any
  }

  const baseStart = {
    tenantId: '22222222-2222-4222-8222-222222222222',
    targetUserId: 'user-99',
    adminId: 'admin-9',
    reason: 'incident-42',
    ipAddress: '198.51.100.1',
  }

  test('no token: middleware passes through with ctx.impersonation null', async ({
    client,
    assert,
  }) => {
    const r = await client.get('/impersonation-check')
    r.assertStatus(200)
    assert.isNull(r.body().impersonation)
  })

  test('valid token: ctx.impersonation is the public context for the session', async ({
    client,
    assert,
  }) => {
    const svc = await getSvc()
    const { token, sessionId } = await svc.start(baseStart)

    const r = await client
      .get('/impersonation-check')
      .header('x-impersonation-token', token)
    r.assertStatus(200)

    const ctx = r.body().impersonation
    assert.isNotNull(ctx, 'middleware must attach a context for a valid token')
    assert.equal(ctx.sessionId, sessionId)
    assert.equal(ctx.tenantId, baseStart.tenantId)
    assert.equal(ctx.userId, baseStart.targetUserId)
    assert.equal(ctx.adminId, baseStart.adminId)
    assert.equal(ctx.adminType, 'admin')

    // First-use audit must be emitted exactly once even if the same
    // request fires the middleware multiple times (it doesn't, but the
    // contract should hold across repeat verifies).
    const firstUse = svc.__audit.calls.filter((c) => c.action === 'admin:impersonate:first-use')
    assert.lengthOf(firstUse, 1)
  })

  test('tampered signature: 401 IMPERSONATION_INVALID', async ({ client, assert }) => {
    const svc = await getSvc()
    const { token } = await svc.start(baseStart)
    const [sid, sig] = token.split('.')
    const flipped = (sig[0] === '0' ? '1' : '0') + sig.slice(1)
    const tampered = `${sid}.${flipped}`

    const r = await client
      .get('/impersonation-check')
      .header('x-impersonation-token', tampered)
    r.assertStatus(401)
    assert.equal(r.body().code, 'E_IMPERSONATION_TOKEN_INVALID')
  })

  test('revoked session via stop(): 401', async ({ client, assert }) => {
    const svc = await getSvc()
    const { token } = await svc.start(baseStart)

    const stopped = await svc.stop(token, { ipAddress: '198.51.100.9' })
    assert.isTrue(stopped, 'precondition: stop() returns true on a fresh token')

    const r = await client
      .get('/impersonation-check')
      .header('x-impersonation-token', token)
    r.assertStatus(401)
    assert.equal(r.body().code, 'E_IMPERSONATION_TOKEN_INVALID')

    // stop() must have written exactly one audit row of action stop.
    const stopRows = svc.__audit.calls.filter((c) => c.action === 'admin:impersonate:stop')
    assert.lengthOf(stopRows, 1)
  })

  test('expired session (force-shifted expiresAt): 401', async ({ client, assert }) => {
    const svc = await getSvc()
    const { token, sessionId } = await svc.start(baseStart)

    // Force-shift the stored session's expiresAt into the past — same
    // clock-drift simulation the unit spec uses, but here we drive it
    // through the HTTP middleware path.
    const ns = getCache().namespace('impersonation')
    const stored = (await ns.get({ key: sessionId })) as any
    assert.isNotNull(stored, 'session must be in cache after start()')
    stored.expiresAt = Date.now() - 1000
    await ns.set({ key: sessionId, value: stored, ttl: 60_000 })

    const r = await client
      .get('/impersonation-check')
      .header('x-impersonation-token', token)
    r.assertStatus(401)
    assert.equal(r.body().code, 'E_IMPERSONATION_TOKEN_INVALID')
  })

  test('cookie fallback: __impersonation cookie is honoured when no header is present', async ({
    client,
    assert,
  }) => {
    const svc = await getSvc()
    const { token, sessionId } = await svc.start(baseStart)

    const r = await client
      .get('/impersonation-check')
      .cookie('__impersonation', token)
    r.assertStatus(200)
    assert.equal(r.body().impersonation?.sessionId, sessionId)
  })
})

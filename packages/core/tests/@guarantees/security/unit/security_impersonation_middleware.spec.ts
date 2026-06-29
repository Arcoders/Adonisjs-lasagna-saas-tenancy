import { test } from '@japa/runner'
import ImpersonationMiddleware from '../../../../src/middleware/impersonation_middleware.js'
import ImpersonationInvalidException from '../../../../src/exceptions/impersonation_invalid_exception.js'
import type { ImpersonationContext } from '../../../../src/types/impersonation.js'
import { setupTestConfig } from '../../../helpers/config.js'

function makeCtx(headers: Record<string, string> = {}, cookies: Record<string, string> = {}) {
  const lower: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v
  return {
    request: {
      header: (key: string) => lower[key.toLowerCase()] ?? null,
      cookie: (name: string) => cookies[name],
    },
  } as any
}

async function catchError(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return undefined
}

function fakeService(verifyImpl: (token: string) => Promise<ImpersonationContext | null>): any {
  return { verify: verifyImpl } as any
}

/**
 * Build a middleware instance that resolves to a fake service via the
 * `getService()` override seam. Mirrors how the production middleware
 * picks up the real `ImpersonationService` from the container —
 * without subclassing here, the container would fail to construct the
 * middleware (it can't resolve the optional `ImpersonationService`
 * dependency without a fully-booted config).
 */
function makeMiddleware(service: any): ImpersonationMiddleware {
  class TestMiddleware extends ImpersonationMiddleware {
    protected getService(): any {
      return Promise.resolve(service)
    }
  }
  return new TestMiddleware()
}

/**
 * Build a middleware whose binding inputs are fully controlled: the verify
 * service, the active tenancy id, the request resolution result, and the
 * by-domain repository. Mirrors the production seams so the binding logic
 * (P1-2: domain resolution must not bypass the check) is exercised without
 * booting the app or a resolver chain.
 */
function makeBindingMiddleware(opts: {
  verified: ImpersonationContext | null
  currentTenantId?: string
  resolved?: any
  findByDomain?: (domain: string) => Promise<{ id: string } | null>
}): ImpersonationMiddleware {
  class TestMiddleware extends ImpersonationMiddleware {
    protected getService(): any {
      return Promise.resolve(fakeService(async () => opts.verified))
    }
    protected currentTenantId(): string | undefined {
      return opts.currentTenantId
    }
    protected resolveRequestTenant(): any {
      return Promise.resolve(opts.resolved)
    }
    protected getRepository(): any {
      return Promise.resolve({
        findByDomain: opts.findByDomain ?? (async () => null),
      })
    }
  }
  return new TestMiddleware()
}

function verifiedFor(tenantId: string): ImpersonationContext {
  return {
    sessionId: 's1',
    tenantId,
    userId: 'u1',
    adminId: 'a1',
    adminType: 'admin',
    startedAt: new Date().toISOString(),
  }
}

test.group('ImpersonationMiddleware', (group) => {
  group.each.setup(() => setupTestConfig())

  test('passes through cleanly when no token is presented', async ({ assert }) => {
    const m = makeMiddleware(fakeService(async () => null))
    let nextCalled = false
    await m.handle(makeCtx(), async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('throws ImpersonationInvalidException when an invalid token is presented', async ({
    assert,
  }) => {
    const m = makeMiddleware(fakeService(async () => null))
    const err = await catchError(() =>
      m.handle(makeCtx({ 'x-impersonation-token': 'bogus' }), async () => {})
    )
    assert.instanceOf(err, ImpersonationInvalidException)
  })

  test('attaches verified context to ctx and calls next() when token is valid', async ({
    assert,
  }) => {
    const verified: ImpersonationContext = {
      sessionId: 's1',
      tenantId: 't1',
      userId: 'u1',
      adminId: 'a1',
      adminType: 'admin',
      startedAt: new Date().toISOString(),
    }
    const m = makeMiddleware(fakeService(async () => verified))
    const ctx = makeCtx({ 'x-impersonation-token': 'goodtoken' })
    let nextCalled = false
    await m.handle(ctx, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
    assert.deepEqual(ctx.impersonation, verified)
  })

  test('reads token from cookie when header is absent', async ({ assert }) => {
    let receivedToken: string | undefined
    const m = makeMiddleware(
      fakeService(async (token) => {
        receivedToken = token
        return null
      })
    )
    await catchError(() => m.handle(makeCtx({}, { __impersonation: 'cookietok' }), async () => {}))
    assert.equal(receivedToken, 'cookietok')
  })
})

/**
 * P1-2: the token↔request tenant binding must hold for ALL resolution
 * strategies, including `domain`/custom-domain. Before the fix, a `domain`
 * envelope left the bound id undefined and the check was skipped, so an
 * A-token attached on B's domain.
 */
test.group('ImpersonationMiddleware — tenant binding under domain resolution', (group) => {
  group.each.setup(() => setupTestConfig())

  test('id resolution: rejects a token for a different tenant than the resolved id', async ({
    assert,
  }) => {
    const m = makeBindingMiddleware({
      verified: verifiedFor('tenant-A'),
      resolved: { type: 'id', tenantId: 'tenant-B' },
    })
    const err = await catchError(() =>
      m.handle(makeCtx({ 'x-impersonation-token': 'tok' }), async () => {})
    )
    assert.instanceOf(err, ImpersonationInvalidException)
  })

  test('domain resolution: rejects when the host maps to a DIFFERENT tenant than the token', async ({
    assert,
  }) => {
    const m = makeBindingMiddleware({
      verified: verifiedFor('tenant-A'),
      resolved: { type: 'domain', domain: 'b.example.com' },
      findByDomain: async (d) => (d === 'b.example.com' ? { id: 'tenant-B' } : null),
    })
    const ctx = makeCtx({ 'x-impersonation-token': 'tok' })
    const err = await catchError(() => m.handle(ctx, async () => {}))
    assert.instanceOf(err, ImpersonationInvalidException)
    assert.isUndefined(ctx.impersonation)
  })

  test('domain resolution: accepts when the host maps to the SAME tenant as the token', async ({
    assert,
  }) => {
    const m = makeBindingMiddleware({
      verified: verifiedFor('tenant-A'),
      resolved: { type: 'domain', domain: 'a.example.com' },
      findByDomain: async (d) => (d === 'a.example.com' ? { id: 'tenant-A' } : null),
    })
    const ctx = makeCtx({ 'x-impersonation-token': 'tok' })
    let nextCalled = false
    await m.handle(ctx, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
    assert.equal(ctx.impersonation?.tenantId, 'tenant-A')
  })

  test('domain resolution: fails closed when the by-domain lookup throws', async ({ assert }) => {
    const m = makeBindingMiddleware({
      verified: verifiedFor('tenant-A'),
      resolved: { type: 'domain', domain: 'b.example.com' },
      findByDomain: async () => {
        throw new Error('backoffice db down')
      },
    })
    const err = await catchError(() =>
      m.handle(makeCtx({ 'x-impersonation-token': 'tok' }), async () => {})
    )
    assert.instanceOf(err, ImpersonationInvalidException)
  })

  test('domain resolution: unknown host (no tenant) has nothing to bind — token attaches', async ({
    assert,
  }) => {
    // A host the package does not manage as a custom domain resolves to no
    // tenant, like a central route — there is nothing to bind against.
    const m = makeBindingMiddleware({
      verified: verifiedFor('tenant-A'),
      resolved: { type: 'domain', domain: 'unmanaged.example.com' },
      findByDomain: async () => null,
    })
    const ctx = makeCtx({ 'x-impersonation-token': 'tok' })
    await m.handle(ctx, async () => {})
    assert.equal(ctx.impersonation?.tenantId, 'tenant-A')
  })
})

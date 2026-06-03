import { test } from '@japa/runner'
import ImpersonationMiddleware from '../../../src/middleware/impersonation_middleware.js'
import ImpersonationInvalidException from '../../../src/exceptions/impersonation_invalid_exception.js'
import type { ImpersonationContext } from '../../../src/types/impersonation.js'
import { setupTestConfig } from '../../helpers/config.js'

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

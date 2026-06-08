import { test } from '@japa/runner'
import CustomDomainMiddleware from '../../../src/middleware/custom_domain_middleware.js'
import TenantHeaderDomainMismatchException from '../../../src/exceptions/tenant_header_domain_mismatch_exception.js'
import type { TenantRepositoryContract } from '../../../src/types/contracts.js'

const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'

/**
 * The middleware destructures `ctx.request`, calls `request.header(...)`, and
 * auto-fills the resolved id onto `request.request.headers`. Model that shape
 * and return both the ctx and the raw headers bag for assertions.
 */
function makeCtx(opts: { host?: string; tenantHeader?: string } = {}) {
  const headers: Record<string, string> = {}
  if (opts.host) headers['host'] = opts.host
  if (opts.tenantHeader) headers['x-tenant-id'] = opts.tenantHeader
  const request = {
    header: (key: string) => headers[key.toLowerCase()] ?? null,
    request: { headers },
  }
  return { ctx: { request } as any, headers }
}

/**
 * Build a middleware whose repository is a fake keyed by domain. Mirrors how
 * the production middleware resolves the repository from the container, via the
 * `getRepository()` override seam, so the unit test needs no booted app.
 */
function makeMiddleware(
  byDomain: Record<string, { id: string } | undefined>,
  onLookup?: () => void
): CustomDomainMiddleware {
  const repo = {
    findByDomain: async (domain: string) => {
      onLookup?.()
      return byDomain[domain] ?? null
    },
  } as unknown as TenantRepositoryContract

  class TestMiddleware extends CustomDomainMiddleware {
    protected getRepository(): Promise<TenantRepositoryContract> {
      return Promise.resolve(repo)
    }
  }
  return new TestMiddleware()
}

async function catchError(fn: () => Promise<void>): Promise<unknown> {
  try {
    await fn()
  } catch (err) {
    return err
  }
  return undefined
}

test.group('CustomDomainMiddleware', () => {
  test('passes through when there is no Host header', async ({ assert }) => {
    const m = makeMiddleware({})
    const { ctx } = makeCtx()
    let nextCalled = false
    await m.handle(ctx, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
  })

  test('non-strict: an explicit header wins and the domain is not consulted', async ({
    assert,
  }) => {
    let lookups = 0
    const m = makeMiddleware({ 'acme.com': { id: UUID_B } }, () => (lookups += 1))
    const { ctx, headers } = makeCtx({ host: 'acme.com', tenantHeader: UUID_A })
    let nextCalled = false
    await m.handle(ctx, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
    assert.equal(lookups, 0)
    // Header left untouched in legacy pass-through.
    assert.equal(headers['x-tenant-id'], UUID_A)
  })

  test('passes through when no tenant claims the Host', async ({ assert }) => {
    const m = makeMiddleware({ 'acme.com': { id: UUID_A } })
    const { ctx, headers } = makeCtx({ host: 'unclaimed.com' })
    let nextCalled = false
    await m.handle(ctx, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
    assert.isUndefined(headers['x-tenant-id'])
  })

  test('auto-fills x-tenant-id from the domain when no header is present', async ({ assert }) => {
    const m = makeMiddleware({ 'acme.com': { id: UUID_A } })
    const { ctx, headers } = makeCtx({ host: 'acme.com' })
    let nextCalled = false
    await m.handle(ctx, async () => {
      nextCalled = true
    })
    assert.isTrue(nextCalled)
    assert.equal(headers['x-tenant-id'], UUID_A)
  })

  test('strict: rejects when the header disagrees with the domain', async ({ assert }) => {
    const m = makeMiddleware({ 'acme.com': { id: UUID_A } })
    const { ctx } = makeCtx({ host: 'acme.com', tenantHeader: UUID_B })
    let nextCalled = false
    const err = await catchError(() =>
      m.handle(
        ctx,
        async () => {
          nextCalled = true
        },
        { strict: true }
      )
    )
    assert.instanceOf(err, TenantHeaderDomainMismatchException)
    assert.isFalse(nextCalled)
  })

  test('strict: allows when the header agrees with the domain', async ({ assert }) => {
    const m = makeMiddleware({ 'acme.com': { id: UUID_A } })
    const { ctx, headers } = makeCtx({ host: 'acme.com', tenantHeader: UUID_A })
    let nextCalled = false
    await m.handle(
      ctx,
      async () => {
        nextCalled = true
      },
      { strict: true }
    )
    assert.isTrue(nextCalled)
    assert.equal(headers['x-tenant-id'], UUID_A)
  })
})

import { test } from '@japa/runner'
import { TenantAccessForbiddenException } from '@adonisjs-lasagna/saas-tenancy/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import AiAuditController from '../../../../src/gateway/ai_audit_controller.js'
import type AiAuditReader from '../../../../src/services/ai_audit_reader.js'
import type { AiAuditQueryFilter } from '../../../../src/services/ai_audit_reader.js'
import type { AiConfig } from '../../../../src/define_config.js'

/**
 * Wave 4 acceptance (3.1): the audit read route is DEFAULT-DENY and TENANT-SCOPED.
 * With no `authorizeAudit` hook it 403s; a throwing or denying hook 403s; an allowing
 * hook returns rows scoped to the request tenant (never a foreign tenant's).
 */

const tenant = { id: 'tenant-A' } as unknown as TenantModelContract

/** A fake reader that records the filter it was queried with. */
function fakeReader() {
  const calls: AiAuditQueryFilter[] = []
  const reader = {
    async query(filter: AiAuditQueryFilter) {
      calls.push(filter)
      return { rows: [{ id: 'row-1' }], page: filter.page ?? 1, limit: filter.limit ?? 50 }
    },
  } as unknown as AiAuditReader
  return { reader, calls }
}

/** A minimal HttpContext with the input()/response surface the controller uses. */
function fakeCtx(query: Record<string, unknown> = {}) {
  let sentStatus: number | undefined
  let sentBody: unknown
  const ctx = {
    request: {
      tenant: async () => tenant,
      input: (name: string) => query[name],
    },
    response: {
      ok(body: unknown) {
        sentStatus = 200
        sentBody = body
      },
    },
  } as unknown as HttpContext
  return { ctx, sent: () => ({ sentStatus, sentBody }) }
}

function controllerWith(audit: AiConfig['audit'], readerParts = fakeReader()) {
  const config = { allowedProviders: ['claude'], audit } as AiConfig
  return {
    controller: new AiAuditController({ reader: readerParts.reader, config }),
    ...readerParts,
  }
}

test.group('AiAuditController — default-deny gate (Wave 4, 3.1)', () => {
  test('no authorizeAudit hook is a 403 (default-deny, distinct from authorizeAIAccess)', async ({
    assert,
  }) => {
    const { controller } = controllerWith({ enabled: true })
    const { ctx } = fakeCtx()
    await assert.rejects(() => controller.list(ctx), TenantAccessForbiddenException.message)
  })

  test('a throwing authorizeAudit hook fails closed (403, never a 500)', async ({ assert }) => {
    const { controller } = controllerWith({
      enabled: true,
      authorizeAudit: () => {
        throw new Error('authz backend down')
      },
    })
    const { ctx } = fakeCtx()
    let threw: unknown
    try {
      await controller.list(ctx)
    } catch (err) {
      threw = err
    }
    assert.instanceOf(threw, TenantAccessForbiddenException)
  })

  test('a denying hook is a 403', async ({ assert }) => {
    const { controller } = controllerWith({ enabled: true, authorizeAudit: () => false })
    const { ctx } = fakeCtx()
    await assert.rejects(() => controller.list(ctx), TenantAccessForbiddenException.message)
  })

  test('an allowing hook returns rows SCOPED to the request tenant', async ({ assert }) => {
    const { controller, calls } = controllerWith({ enabled: true, authorizeAudit: () => true })
    const { ctx, sent } = fakeCtx({ op: 'chat', principalHash: 'p', page: '2', limit: '10' })
    await controller.list(ctx)

    assert.equal(sent().sentStatus, 200)
    assert.lengthOf(calls, 1)
    // The filter is pinned to the request tenant — a client cannot read another tenant.
    assert.equal(calls[0]!.tenantId, 'tenant-A')
    assert.equal(calls[0]!.op, 'chat')
    assert.equal(calls[0]!.principalHash, 'p')
    assert.equal(calls[0]!.page, 2)
    assert.equal(calls[0]!.limit, 10)
  })

  test('a malformed op query param is dropped before it reaches the reader', async ({ assert }) => {
    const { controller, calls } = controllerWith({ enabled: true, authorizeAudit: () => true })
    const { ctx } = fakeCtx({ op: 'evil', outcome: 'nonsense' })
    await controller.list(ctx)
    assert.isUndefined(calls[0]!.op)
    assert.isUndefined(calls[0]!.outcome)
  })
})

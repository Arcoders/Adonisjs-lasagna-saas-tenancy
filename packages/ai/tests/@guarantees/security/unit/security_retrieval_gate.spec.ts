import { test } from '@japa/runner'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'
import type { IsthmusGuardTrippedPayload } from '@adonisjs-lasagna/saas-tenancy/types'
import { resolveRetrievalScope } from '../../../../src/gateway/access_gate.js'
import AIException from '../../../../src/exceptions/ai_exception.js'
import {
  __resetAiGuardCounters,
  __resetAiGuardRateLimit,
  __setAiGuardDispatcherForTests,
} from '../../../../src/isthmus/ai_guard_audit.js'
import type { AIRetrievalConfig } from '../../../../src/define_config.js'

/**
 * The retrieval scope gate (WS-AI-5, G2). The per-user document ACL is resolved
 * BEFORE any query embed or search. An absent hook is the documented honest
 * limit (the whole tenant corpus, `{ kind: 'all' }`); a wired hook is
 * authoritative and fail-closed: a throw or an invalid return is a 403
 * `retrieval_denied` plus a `guard.ai_retrieval_denied` trip, never a silent
 * fallback to the whole corpus.
 */

const tenant = { id: 'tenant-1' } as unknown as TenantModelContract
const ctx = {} as never
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function retrieval(overrides: Partial<AIRetrievalConfig>): AIRetrievalConfig {
  return { ...overrides }
}

test.group('AI retrieval scope gate', (group) => {
  let captured: IsthmusGuardTrippedPayload[] = []

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

  test('an absent hook scopes to the whole tenant corpus without emitting', async ({ assert }) => {
    assert.deepEqual(await resolveRetrievalScope(ctx, tenant, undefined), { kind: 'all' })
    assert.deepEqual(await resolveRetrievalScope(ctx, tenant, retrieval({})), { kind: 'all' })
    await settle()
    assert.lengthOf(captured, 0)
  })

  test('a hook returning a sources allow-list passes through unchanged', async ({ assert }) => {
    const scope = await resolveRetrievalScope(
      ctx,
      tenant,
      retrieval({ retrievalFilter: () => ({ kind: 'sources', sources: ['doc-a', 'doc-b'] }) })
    )
    assert.deepEqual(scope, { kind: 'sources', sources: ['doc-a', 'doc-b'] })
    await settle()
    assert.lengthOf(captured, 0)
  })

  test('a hook returning an EMPTY sources allow-list is valid (sees nothing), not an error', async ({
    assert,
  }) => {
    const scope = await resolveRetrievalScope(
      ctx,
      tenant,
      retrieval({ retrievalFilter: () => ({ kind: 'sources', sources: [] }) })
    )
    assert.deepEqual(scope, { kind: 'sources', sources: [] })
    await settle()
    assert.lengthOf(captured, 0)
  })

  test('an async hook returning a metadata match passes through', async ({ assert }) => {
    const scope = await resolveRetrievalScope(
      ctx,
      tenant,
      retrieval({ retrievalFilter: async () => ({ kind: 'metadata', match: { team: 'eng' } }) })
    )
    assert.deepEqual(scope, { kind: 'metadata', match: { team: 'eng' } })
    await settle()
    assert.lengthOf(captured, 0)
  })

  test('a THROWING hook is a fail-closed 403 (with cause) plus reason "hook_error"', async ({
    assert,
  }) => {
    const aclDown = new Error('acl backend unreachable')
    let threw: unknown
    try {
      await resolveRetrievalScope(
        ctx,
        tenant,
        retrieval({
          retrievalFilter: () => {
            throw aclDown
          },
        })
      )
    } catch (err) {
      threw = err
    }
    await settle()

    assert.instanceOf(threw, AIException)
    assert.equal((threw as AIException).aiCode, 'retrieval_denied')
    assert.equal((threw as AIException).httpStatus, 403)
    assert.isFalse((threw as AIException).isRetryable())
    assert.equal((threw as AIException).originalError, aclDown)
    assert.lengthOf(captured, 1)
    assert.equal(captured[0].id, 'guard.ai_retrieval_denied')
    assert.equal(captured[0].tenantId, 'tenant-1')
    assert.equal(captured[0].metadata.reason, 'hook_error')
  })

  test('a hook returning an invalid scope shape is a fail-closed 403, reason "invalid_scope"', async ({
    assert,
  }) => {
    for (const bad of [
      true,
      null,
      { kind: 'everything' },
      { kind: 'sources', sources: 'not-an-array' },
      { kind: 'sources', sources: [1, 2] },
      { kind: 'metadata', match: null },
      { kind: 'metadata', match: [] },
    ]) {
      captured = []
      let threw: unknown
      try {
        await resolveRetrievalScope(ctx, tenant, retrieval({ retrievalFilter: () => bad as never }))
      } catch (err) {
        threw = err
      }
      await settle()

      assert.instanceOf(threw, AIException, `scope ${JSON.stringify(bad)} must be refused`)
      assert.equal((threw as AIException).aiCode, 'retrieval_denied')
      assert.lengthOf(captured, 1)
      assert.equal(captured[0].metadata.reason, 'invalid_scope')
    }
  })
})

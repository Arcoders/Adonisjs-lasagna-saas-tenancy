import { test } from '@japa/runner'
import AuthorizerRegistry, {
  AUTHORIZER_CONTRACT_VERSION,
  type TenantAuthorizer,
  type TenantAuthorizerEntry,
} from '../../../../src/services/authorizer_registry.js'
import { authorizerName } from '../../../../src/sdk/brands.js'
import { __resetIsthmusCounters, snapshotIsthmusCounters } from '../../../../src/isthmus/audit.js'
import type { HttpContext } from '@adonisjs/core/http'
import type { TenantModelContract } from '../../../../src/types/contracts.js'

/**
 * SEAM-3 — the tenant-access authorizer chain. The load-bearing guarantee is
 * FAIL-CLOSED: config.authorizeTenantAccess runs first, then every registered
 * authorizer; ANY false-or-throw denies, and an empty chain with no config
 * callback allows (byte-identical to the pre-seam behavior). A thrown authorizer
 * is a deny, never a pass, and the throw never surfaces to the caller.
 */

const tenant = { id: 'tenant-1' } as unknown as TenantModelContract

function makeCtx(): { ctx: HttpContext; logs: unknown[] } {
  const logs: unknown[] = []
  const ctx = {
    logger: { error: (...args: unknown[]) => logs.push(args) },
  } as unknown as HttpContext
  return { ctx, logs }
}

function authorizer(
  name: string,
  authorize: TenantAuthorizer,
  order?: number
): TenantAuthorizerEntry {
  return {
    kind: 'authorizer',
    name: authorizerName(name),
    authorize,
    ...(order !== undefined ? { order } : {}),
  }
}

const ALLOW = { allow: true } as const

test.group('AuthorizerRegistry — registration', () => {
  test('exposes the contract version', ({ assert }) => {
    assert.equal(new AuthorizerRegistry().contractVersion, AUTHORIZER_CONTRACT_VERSION)
  })

  test('register / has / list / unregister', ({ assert }) => {
    const reg = new AuthorizerRegistry()
    reg.register(authorizer('gate_a', () => ALLOW))
    reg.register(authorizer('gate_b', () => ALLOW))

    assert.deepEqual(reg.list(), ['gate_a', 'gate_b'])
    assert.isTrue(reg.has(authorizerName('gate_a')))
    assert.isTrue(reg.unregister(authorizerName('gate_a')))
    assert.isFalse(reg.has(authorizerName('gate_a')))
    assert.deepEqual(reg.list(), ['gate_b'])
  })

  test('duplicate name throws a typed PluginAuthorizerException (500), not a bare Error', ({
    assert,
  }) => {
    const reg = new AuthorizerRegistry()
    reg.register(authorizer('dup', () => ALLOW))
    assert.throws(() => reg.register(authorizer('dup', () => ALLOW)), /already registered/)
    try {
      reg.register(authorizer('dup', () => ALLOW))
    } catch (err: any) {
      assert.equal(err.code, 'E_PLUGIN_AUTHORIZER')
      assert.equal(err.status, 500)
    }
  })

  test('an authorizer built for a NEWER contract is rejected at registration', ({ assert }) => {
    const reg = new AuthorizerRegistry()
    assert.throws(
      () =>
        reg.register({
          kind: 'authorizer',
          name: authorizerName('too_new'),
          authorize: () => ALLOW,
          contractVersion: AUTHORIZER_CONTRACT_VERSION + 1,
        }),
      /requires extension contract/
    )
  })

  test('an unsafe authorizer name is refused when minted', ({ assert }) => {
    assert.throws(() => authorizerName('bad:name'), /unsafe/)
    assert.throws(() => authorizerName('has space'), /unsafe/)
  })
})

test.group('AuthorizerRegistry — authorizeAll (fail-closed chain)', () => {
  test('empty chain + no config callback → allow (byte-identical to today)', async ({ assert }) => {
    const { ctx } = makeCtx()
    const decision = await new AuthorizerRegistry().authorizeAll(ctx, tenant)
    assert.deepEqual(decision, { allow: true })
  })

  test('config callback returning false → deny', async ({ assert }) => {
    const { ctx } = makeCtx()
    const decision = await new AuthorizerRegistry().authorizeAll(ctx, tenant, () => false)
    assert.isFalse(decision.allow)
  })

  test('config callback that THROWS → deny (fail-closed) + logged', async ({ assert }) => {
    const { ctx, logs } = makeCtx()
    const decision = await new AuthorizerRegistry().authorizeAll(ctx, tenant, () => {
      throw new Error('auth infra down')
    })
    assert.isFalse(decision.allow)
    assert.equal(logs.length, 1)
  })

  test('config callback runs BEFORE registered authorizers', async ({ assert }) => {
    const { ctx } = makeCtx()
    const order: string[] = []
    const reg = new AuthorizerRegistry()
    reg.register(
      authorizer('after_config', () => {
        order.push('authorizer')
        return ALLOW
      })
    )
    await reg.authorizeAll(ctx, tenant, () => {
      order.push('config')
      return true
    })
    assert.deepEqual(order, ['config', 'authorizer'])
  })

  test('a registered authorizer returning {allow:false, reason} → deny with reason preserved', async ({
    assert,
  }) => {
    const { ctx } = makeCtx()
    const reg = new AuthorizerRegistry()
    reg.register(authorizer('deny', () => ({ allow: false, reason: 'not a member' })))
    const decision = await reg.authorizeAll(ctx, tenant)
    assert.deepEqual(decision, { allow: false, reason: 'not a member' })
  })

  test('a registered authorizer that THROWS → deny (fail-closed), throw never surfaces', async ({
    assert,
  }) => {
    const { ctx, logs } = makeCtx()
    const reg = new AuthorizerRegistry()
    reg.register(
      authorizer('boom', () => {
        throw new Error('kaboom')
      })
    )
    const decision = await reg.authorizeAll(ctx, tenant)
    assert.isFalse(decision.allow)
    assert.equal(logs.length, 1)
  })

  test('a thrown authorizer trips the guard.plugin_authorizer isthmus counter (fail-closed is observable)', async ({
    assert,
  }) => {
    __resetIsthmusCounters()
    const { ctx } = makeCtx()
    const reg = new AuthorizerRegistry()
    reg.register(
      authorizer('boom_obs', () => {
        throw new Error('infra')
      })
    )
    const decision = await reg.authorizeAll(ctx, tenant)
    assert.isFalse(decision.allow)
    const rejected = snapshotIsthmusCounters().rejected.find(
      (r) => r.id === 'guard.plugin_authorizer'
    )
    assert.isDefined(rejected)
    assert.isAbove(rejected?.value ?? 0, 0)
  })

  test('first deny short-circuits: later authorizers do not run', async ({ assert }) => {
    const { ctx } = makeCtx()
    let secondRan = false
    const reg = new AuthorizerRegistry()
    reg.register(authorizer('first', () => ({ allow: false }), 1))
    reg.register(
      authorizer(
        'second',
        () => {
          secondRan = true
          return ALLOW
        },
        2
      )
    )
    const decision = await reg.authorizeAll(ctx, tenant)
    assert.isFalse(decision.allow)
    assert.isFalse(secondRan)
  })

  test('a hung authorizer denies on the deadline (deadline-to-deny, fail-closed)', async ({
    assert,
  }) => {
    __resetIsthmusCounters()
    const { ctx } = makeCtx()
    const reg = new AuthorizerRegistry()
    reg.register(authorizer('hangs', () => new Promise<never>(() => {}))) // never resolves
    // Tiny deadline so the test is fast; production uses AUTHORIZER_DEADLINE_MS.
    const decision = await reg.authorizeAll(ctx, tenant, undefined, 25)
    assert.isFalse(decision.allow)
    assert.match((decision as { reason: string }).reason, /timeout/)
    const rejected = snapshotIsthmusCounters().rejected.find(
      (r) => r.id === 'guard.plugin_authorizer'
    )
    assert.isAbove(rejected?.value ?? 0, 0)
  })

  test('all-allow chain → allow', async ({ assert }) => {
    const { ctx } = makeCtx()
    const reg = new AuthorizerRegistry()
    reg.register(authorizer('a', () => ALLOW))
    reg.register(authorizer('b', async () => ALLOW))
    const decision = await reg.authorizeAll(ctx, tenant, () => true)
    assert.deepEqual(decision, { allow: true })
  })

  test('runs in ascending order, ties by registration order', async ({ assert }) => {
    const { ctx } = makeCtx()
    const seen: string[] = []
    const reg = new AuthorizerRegistry()
    reg.register(
      authorizer(
        'late',
        () => {
          seen.push('late')
          return ALLOW
        },
        10
      )
    )
    reg.register(
      authorizer(
        'early',
        () => {
          seen.push('early')
          return ALLOW
        },
        1
      )
    )
    reg.register(
      authorizer('tie_a', () => {
        seen.push('tie_a')
        return ALLOW
      })
    )
    reg.register(
      authorizer('tie_b', () => {
        seen.push('tie_b')
        return ALLOW
      })
    )
    await reg.authorizeAll(ctx, tenant)
    // order 0 (tie_a, tie_b in registration order), then 1 (early), then 10 (late)
    assert.deepEqual(seen, ['tie_a', 'tie_b', 'early', 'late'])
  })
})

import { test } from '@japa/runner'
import { assertCoreAccessAllowed } from '../../../../src/services/plugin_core_access.js'
import { resolveTenantRepository } from '../../../../src/services/resolve_tenant_repository.js'
import { resolveDatabase } from '../../../../src/services/resolve_database.js'
import { pluginScope } from '../../../../src/services/plugin_execution_scope.js'
import { pluginName } from '../../../../src/sdk/brands.js'

/**
 * S5 — the core-access funnel. When UNTRUSTED plugin code is on the stack, the
 * sanctioned accessors for core singletons (`resolveTenantRepository`,
 * `resolveDatabase`) deny the lookup with a 403 BEFORE the handle is resolved.
 * Core's own code and trusted plugins pass through. This is labeled friction, not a
 * boundary (a direct import evades it) — the read-only Postgres role is the wall.
 */

const untrusted = { plugin: pluginName('sketchy'), trusted: false }
const trusted = { plugin: pluginName('reporting'), trusted: true }

test.group('assertCoreAccessAllowed', () => {
  test('is a no-op outside any plugin scope (core code)', ({ assert }) => {
    assert.doesNotThrow(() => assertCoreAccessAllowed('tenant-repository'))
  })

  test('is a no-op inside a TRUSTED plugin scope', ({ assert }) => {
    assert.doesNotThrow(() =>
      pluginScope.run(trusted, () => assertCoreAccessAllowed('tenant-repository'))
    )
  })

  test('denies (403, attributed) inside an UNTRUSTED plugin scope', ({ assert }) => {
    let threw: any
    pluginScope.run(untrusted, () => {
      try {
        assertCoreAccessAllowed('tenant-repository')
      } catch (err) {
        threw = err
      }
    })
    assert.isDefined(threw)
    assert.equal(threw.code, 'E_UNAUTHORIZED_CORE_ACCESS')
    assert.equal(threw.status, 403)
    assert.equal(threw.plugin, 'sketchy')
    assert.match(threw.message, /refusing untrusted plugin "sketchy"/)
  })
})

test.group('resolveTenantRepository — S5 guard', () => {
  test('denies an untrusted plugin before hitting the container', async ({ assert }) => {
    let madeCount = 0
    const resolver = {
      async make() {
        madeCount++
        return {}
      },
    }
    await assert.rejects(
      () => pluginScope.run(untrusted, () => resolveTenantRepository(resolver)),
      /refusing untrusted plugin/
    )
    assert.equal(madeCount, 0, 'the container must not be consulted once the guard denies')
  })

  test('lets core code (no scope) and trusted plugins through', async ({ assert }) => {
    const repo = { marker: true }
    const resolver = {
      async make() {
        return repo
      },
    }

    assert.strictEqual(await resolveTenantRepository(resolver as any), repo)
    assert.strictEqual(
      await pluginScope.run(trusted, () => resolveTenantRepository(resolver as any)),
      repo
    )
  })
})

test.group('resolveDatabase — S5 guard', () => {
  test('denies an untrusted plugin before importing the db service', async ({ assert }) => {
    // The guard throws before the lazy `@adonisjs/lucid/services/db` import, so this
    // is safe to exercise without a booted app (which the trusted path would need).
    await assert.rejects(
      () => pluginScope.run(untrusted, () => resolveDatabase()),
      /refusing untrusted plugin/
    )
  })
})

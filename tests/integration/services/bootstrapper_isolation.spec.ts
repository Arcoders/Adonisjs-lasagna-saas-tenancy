import { test } from '@japa/runner'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import { tenancy } from '@adonisjs-lasagna/saas-tenancy'
import {
  cacheBootstrapper,
  driveBootstrapper,
  sessionBootstrapper,
  transmitBootstrapper,
  tenantCache,
  tenantPrefix,
  tenantSession,
  tenantSessionKey,
  tenantChannel,
  BootstrapperRegistry,
} from '@adonisjs-lasagna/saas-tenancy/services'
import type { TenantModelContract } from '@adonisjs-lasagna/saas-tenancy/types'

/**
 * Cross-tenant isolation guarantees of the four "context bootstrappers"
 * (cache / drive / session / transmit). Each spec creates two UUID-v4
 * tenants, exercises the bootstrapper's public API under `tenancy.run()`,
 * and asserts the underlying store/path/channel never leaks one tenant's
 * data into the other's read path.
 *
 * Drive and Transmit are optional peer deps and may not be installed in
 * the integration test process — instead of trying to load them, we
 * exercise the BOOTSTRAPPER's contribution directly:
 *
 *   - `tenantPrefix()` (drive) → use `fs` with that prefix to prove
 *     two tenants writing under the same logical key produce
 *     physically disjoint files on disk.
 *   - `tenantChannel()` (transmit) → verify two tenants subscribing
 *     to the same logical channel name produce distinct wire names.
 *
 * Cache uses real Redis (the package's `tenantCache()` resolves the
 * BentoCache singleton bootstrapped by the integration fixture).
 *
 * Session uses an in-memory `Map` store standing in for `@adonisjs/session`
 * (which is an optional peer). The package's `tenantSession(ctx)` wraps a
 * conforming `ctx.session` regardless of the underlying driver, so the
 * isolation contract is the same.
 */
function fakeTenant(id?: string): TenantModelContract {
  return { id: id ?? randomUUID(), name: `T-${id ?? 'auto'}` } as unknown as TenantModelContract
}

function makeSessionCtx() {
  const store = new Map<string, unknown>()
  const session = {
    get: (k: string, def?: unknown) => (store.has(k) ? store.get(k) : def),
    put: (k: string, v: unknown) => store.set(k, v),
    forget: (k: string) => store.delete(k),
    has: (k: string) => store.has(k),
    pull: (k: string, def?: unknown) => {
      const v = store.has(k) ? store.get(k) : def
      store.delete(k)
      return v
    },
  }
  return { ctx: { session } as any, store }
}

async function withBootstrappers<T>(fn: () => Promise<T>): Promise<T> {
  // The integration fixture's MultitenancyProvider registers the package's
  // bootstrappers at boot. We re-register inside an isolated registry so
  // the test is self-contained AND parallel-safe — touching the container
  // singleton would race with other specs in the suite.
  const registry = await app.container.make(BootstrapperRegistry)
  const had = {
    cache: registry.has('cache'),
    drive: registry.has('drive'),
    session: registry.has('session'),
    transmit: registry.has('transmit'),
  }
  if (!had.cache) registry.register(cacheBootstrapper)
  if (!had.drive) registry.register(driveBootstrapper)
  if (!had.session) registry.register(sessionBootstrapper)
  if (!had.transmit) registry.register(transmitBootstrapper)
  try {
    return await fn()
  } finally {
    if (!had.cache) registry.unregister('cache')
    if (!had.drive) registry.unregister('drive')
    if (!had.session) registry.unregister('session')
    if (!had.transmit) registry.unregister('transmit')
  }
}

test.group('e2e — bootstrapper cross-tenant isolation', (group) => {
  let tmpRoot: string

  group.setup(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), 'lasagna-bootstrapper-iso-'))
  })

  group.teardown(async () => {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => {})
  })

  test('cache: two tenants writing the same key see independent values via tenantCache()', async ({
    assert,
  }) => {
    const a = fakeTenant()
    const b = fakeTenant()

    await withBootstrappers(async () => {
      await tenancy.run(a, async () => {
        await tenantCache().set({ key: 'shared', value: 'A-value' })
      })
      await tenancy.run(b, async () => {
        await tenantCache().set({ key: 'shared', value: 'B-value' })
      })

      const readA = await tenancy.run(a, async () => tenantCache().get({ key: 'shared' }))
      const readB = await tenancy.run(b, async () => tenantCache().get({ key: 'shared' }))
      assert.equal(readA, 'A-value', 'A must read its own value')
      assert.equal(readB, 'B-value', "B must not see A's value under the same key")

      // Delete from A — must not affect B.
      await tenancy.run(a, async () => tenantCache().delete({ key: 'shared' }))
      const afterDeleteA = await tenancy.run(a, async () => tenantCache().get({ key: 'shared' }))
      const afterDeleteB = await tenancy.run(b, async () => tenantCache().get({ key: 'shared' }))
      assert.isUndefined(afterDeleteA, "A's key was deleted")
      assert.equal(afterDeleteB, 'B-value', "B's data must survive A's delete")
    })
  })

  test('cache: tenantCache() throws outside a tenancy.run() scope', ({ assert }) => {
    assert.throws(() => tenantCache(), /outside a tenancy\.run\(\) scope/)
  })

  test('drive: tenants writing the same logical key produce physically disjoint files', async ({
    assert,
  }) => {
    const a = fakeTenant()
    const b = fakeTenant()

    await withBootstrappers(async () => {
      const writeUnderPrefix = async (content: string) => {
        const prefix = tenantPrefix() // logical: tenants/<id>/ (forward slash)
        const dir = join(tmpRoot, prefix)
        await mkdir(dir, { recursive: true })
        await writeFile(join(dir, 'doc.txt'), content, 'utf8')
        return { prefix, physicalPath: join(dir, 'doc.txt') }
      }

      const { prefix: prefixA, physicalPath: pathA } = await tenancy.run(a, () =>
        writeUnderPrefix('A-content')
      )
      const { prefix: prefixB, physicalPath: pathB } = await tenancy.run(b, () =>
        writeUnderPrefix('B-content')
      )

      // The bootstrapper's contract is on the LOGICAL prefix it returns —
      // that prefix is a key prefix, not a filesystem path, so it always
      // uses forward slashes (Drive/S3 semantics) regardless of platform.
      assert.equal(prefixA, `tenants/${a.id}/`, 'prefix A shape')
      assert.equal(prefixB, `tenants/${b.id}/`, 'prefix B shape')
      assert.notEqual(prefixA, prefixB)
      assert.notEqual(pathA, pathB)

      const onDiskA = await readFile(pathA, 'utf8')
      const onDiskB = await readFile(pathB, 'utf8')
      assert.equal(onDiskA, 'A-content')
      assert.equal(onDiskB, 'B-content')

      // B's prefix path must NOT contain A's content — i.e. B writing
      // `doc.txt` under its prefix did not land at the same physical
      // location as A's. The disjoint readFile() above already proves it,
      // but make the negative assertion explicit.
      const pathB_underA_prefix = join(tmpRoot, prefixA, 'doc.txt')
      const reread = await readFile(pathB_underA_prefix, 'utf8')
      assert.notEqual(reread, 'B-content', "A's prefix slot must not hold B's content")
      assert.equal(reread, 'A-content', "A's prefix slot must still hold A's content")
    })
  })

  test('drive: tenantPrefix() throws outside a tenancy.run() scope', ({ assert }) => {
    assert.throws(() => tenantPrefix(), /outside a tenancy\.run\(\) scope/)
  })

  test('session: writes under the same logical key land in distinct namespaced slots', async ({
    assert,
  }) => {
    const a = fakeTenant()
    const b = fakeTenant()
    const { ctx, store } = makeSessionCtx()

    await withBootstrappers(async () => {
      await tenancy.run(a, async () => {
        tenantSession(ctx).put('cart', ['A-item'])
      })
      await tenancy.run(b, async () => {
        tenantSession(ctx).put('cart', ['B-item'])
      })

      // Physical store carries TWO keys, each prefixed by its tenant.
      assert.equal(store.size, 2, 'two writes under same logical key → two physical slots')
      assert.deepEqual(store.get(`tenants/${a.id}/cart`), ['A-item'])
      assert.deepEqual(store.get(`tenants/${b.id}/cart`), ['B-item'])

      // Reads inside each scope see only the tenant's own slot.
      const fromA = await tenancy.run(a, async () => tenantSession(ctx).get('cart'))
      const fromB = await tenancy.run(b, async () => tenantSession(ctx).get('cart'))
      assert.deepEqual(fromA, ['A-item'])
      assert.deepEqual(fromB, ['B-item'])

      // `has(key)` must respect the active scope.
      const hasInA = await tenancy.run(a, async () => tenantSession(ctx).has('cart'))
      const hasInB = await tenancy.run(b, async () => tenantSession(ctx).has('cart'))
      assert.isTrue(hasInA)
      assert.isTrue(hasInB)
    })
  })

  test('session: tenantSessionKey() throws outside a tenancy.run() scope', ({ assert }) => {
    assert.throws(() => tenantSessionKey('cart'), /outside a tenancy\.run\(\) scope/)
  })

  test('transmit: two tenants subscribing to the same logical channel get distinct wire names', async ({
    assert,
  }) => {
    const a = fakeTenant()
    const b = fakeTenant()

    await withBootstrappers(async () => {
      const wireA = await tenancy.run(a, async () => tenantChannel('chat/lobby'))
      const wireB = await tenancy.run(b, async () => tenantChannel('chat/lobby'))

      assert.equal(wireA, `tenants/${a.id}/chat/lobby`)
      assert.equal(wireB, `tenants/${b.id}/chat/lobby`)
      assert.notEqual(wireA, wireB, 'two tenants must never collide on the same logical channel')

      // Path-traversal in the channel suffix must be rejected even with a
      // valid tenant scope active — it could otherwise produce a wire name
      // that lands inside another tenant's prefix.
      await tenancy.run(a, async () => {
        assert.throws(() => tenantChannel('../escape'), /Refusing unsafe broadcast channel|escape the per-tenant namespace/)
      })
    })
  })

  test('transmit: tenantChannel() throws outside a tenancy.run() scope', ({ assert }) => {
    assert.throws(() => tenantChannel('chat'), /outside a tenancy\.run\(\) scope/)
  })

  test('AsyncLocalStorage: 16 parallel tenancy.run() scopes never bleed bindings into each other', async ({
    assert,
  }) => {
    const tenants = Array.from({ length: 16 }, () => fakeTenant())

    await withBootstrappers(async () => {
      const results = await Promise.all(
        tenants.map((t, idx) =>
          tenancy.run(t, async () => {
            // A few awaits to give the runtime a chance to interleave scopes.
            await new Promise((r) => setImmediate(r))
            await tenantCache().set({ key: 'who', value: `T-${idx}` })
            await new Promise((r) => setTimeout(r, 10))
            const readBack = await tenantCache().get({ key: 'who' })
            const prefix = tenantPrefix()
            const channel = tenantChannel('updates')
            return { idx, id: t.id, readBack, prefix, channel }
          })
        )
      )

      // Every scope must have read back ITS OWN value — no cross-contamination
      // via the shared cache namespace handle. AsyncLocalStorage is the
      // contract that keeps `tenancy.currentId()` accurate per scope across
      // the awaits above.
      for (const r of results) {
        assert.equal(r.readBack, `T-${r.idx}`, `scope #${r.idx} (${r.id}) must read back its own write`)
        assert.equal(r.prefix, `tenants/${r.id}/`, `scope #${r.idx} prefix must reflect ITS tenant id`)
        assert.equal(r.channel, `tenants/${r.id}/updates`, `scope #${r.idx} channel must reflect ITS tenant id`)
      }

      // Cleanup the test keys so we don't leave junk in Redis.
      for (const t of tenants) {
        await tenancy.run(t, async () => tenantCache().delete({ key: 'who' }))
      }
    })
  })
})

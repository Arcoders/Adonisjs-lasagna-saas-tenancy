import { test } from '@japa/runner'
import { runTenantMigrations } from '../../../../src/services/isolation/tenant_migration_runner.js'

/**
 * SEAM-2 core: a satellite's per-tenant migration directories reach the Migrator
 * via `MigrateOptions.extraMigrationPaths`. Lucid's Migrator reads its source
 * directories from the CONNECTION's `migrations.paths`, not from its options, so
 * the runner folds the extra paths in by cloning the tenant connection into a
 * throwaway registration and running against that. These specs pin that folding
 * without a real database (the Lucid db + MigrationRunner are injected).
 */
function fakeLucid(
  registered: Map<string, any>,
  opts: { throwOnRun?: boolean; runnerError?: unknown } = {}
) {
  const calls = {
    added: [] as Array<{ name: string; paths: string[] }>,
    released: [] as string[],
    ranAgainst: [] as string[],
  }
  const db = {
    manager: {
      get: (n: string) => registered.get(n),
      has: (n: string) => registered.has(n),
      add: (n: string, cfg: any) => {
        registered.set(n, { config: cfg })
        calls.added.push({ name: n, paths: cfg?.migrations?.paths ?? [] })
      },
      release: async (n: string) => {
        registered.delete(n)
        calls.released.push(n)
      },
    },
  }
  class MigrationRunner {
    migratedFiles: Record<string, unknown>
    error: unknown = opts.runnerError ?? null
    constructor(_db: unknown, _app: unknown, o: { connectionName: string }) {
      calls.ranAgainst.push(o.connectionName)
      const cfg = registered.get(o.connectionName)?.config
      const paths: string[] = cfg?.migrations?.paths ?? ['database/migrations']
      // one "migrated file" per source directory, so `executed` reflects folding
      this.migratedFiles = Object.fromEntries(paths.map((p, i) => [`m${i}`, p]))
    }
    async run() {
      if (opts.throwOnRun) throw new Error('run boom')
    }
  }
  return { getLucid: async () => ({ db, app: {}, MigrationRunner }), calls }
}

const tenantConn = (paths?: string[]) =>
  new Map<string, any>([
    [
      'tenant_x',
      { config: { connection: { database: 'app' }, ...(paths ? { migrations: { paths } } : {}) } },
    ],
  ])

test.group('runTenantMigrations — extraMigrationPaths folding', () => {
  test('no extra paths: runs against the tenant connection directly, no throwaway', async ({
    assert,
  }) => {
    const reg = tenantConn(['database/migrations/tenant'])
    const { getLucid, calls } = fakeLucid(reg)
    const res = await runTenantMigrations('tenant_x', { direction: 'up' }, { getLucid })
    assert.deepEqual(calls.ranAgainst, ['tenant_x'])
    assert.lengthOf(calls.added, 0, 'no throwaway connection registered')
    assert.lengthOf(calls.released, 0)
    assert.equal(res.executed, 1, 'one source dir -> one migrated file')
  })

  test('extra paths: folds them into a throwaway clone and releases it', async ({ assert }) => {
    const reg = tenantConn(['database/migrations/tenant'])
    const { getLucid, calls } = fakeLucid(reg)
    const res = await runTenantMigrations(
      'tenant_x',
      { direction: 'up', extraMigrationPaths: ['node_modules/@x/ai/tenant'] },
      { getLucid }
    )
    assert.lengthOf(calls.added, 1, 'one throwaway registered')
    assert.isTrue(calls.added[0]!.name.startsWith('__migpaths_tenant_x_'))
    assert.deepEqual(
      calls.added[0]!.paths,
      ['database/migrations/tenant', 'node_modules/@x/ai/tenant'],
      'base paths + extra, in order'
    )
    assert.deepEqual(calls.ranAgainst, [calls.added[0]!.name], 'ran against the throwaway')
    assert.deepEqual(calls.released, [calls.added[0]!.name], 'throwaway released')
    assert.equal(res.executed, 2, 'two source dirs -> two migrated files')
  })

  test('a connection without a migrations block falls back to database/migrations', async ({
    assert,
  }) => {
    const reg = tenantConn() // no migrations.paths (e.g. sqlite-memory)
    const { getLucid, calls } = fakeLucid(reg)
    await runTenantMigrations(
      'tenant_x',
      { direction: 'up', extraMigrationPaths: ['x/y'] },
      { getLucid }
    )
    assert.deepEqual(calls.added[0]!.paths, ['database/migrations', 'x/y'])
  })

  test('empty / whitespace extra paths are ignored (treated as no-extra)', async ({ assert }) => {
    const reg = tenantConn(['database/migrations/tenant'])
    const { getLucid, calls } = fakeLucid(reg)
    await runTenantMigrations(
      'tenant_x',
      { direction: 'up', extraMigrationPaths: ['', ''] },
      { getLucid }
    )
    assert.deepEqual(calls.ranAgainst, ['tenant_x'])
    assert.lengthOf(calls.added, 0)
  })

  test('the throwaway is released even when the migration run throws', async ({ assert }) => {
    const reg = tenantConn(['database/migrations/tenant'])
    const { getLucid, calls } = fakeLucid(reg, { throwOnRun: true })
    await assert.rejects(
      () =>
        runTenantMigrations(
          'tenant_x',
          { direction: 'up', extraMigrationPaths: ['x/y'] },
          { getLucid }
        ),
      /run boom/
    )
    assert.deepEqual(
      calls.released,
      calls.added.map((a) => a.name),
      'throwaway still released'
    )
  })

  test('a runner.error is surfaced as a throw', async ({ assert }) => {
    const reg = tenantConn(['database/migrations/tenant'])
    const { getLucid } = fakeLucid(reg, { runnerError: new Error('ledger corrupt') })
    await assert.rejects(
      () => runTenantMigrations('tenant_x', { direction: 'up' }, { getLucid }),
      /ledger corrupt/
    )
  })
})

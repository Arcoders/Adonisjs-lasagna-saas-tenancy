import { test } from '@japa/runner'
import {
  mkdtemp,
  rm,
  mkdir,
  writeFile,
  readFile,
  readdir,
  access,
  appendFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import configure from '../../configure.js'

/**
 * File-level test of `configure()`'s orchestration: selection → resolve →
 * dedup → idempotency guard → publish. We don't exercise the AdonisJS stub
 * renderer (framework code); instead we drive the real `configure()` with a
 * fake command whose `makeUsingStub` writes the *same destinations* the real
 * stubs target — crucially `database/migrations/${Date.now()}_<stub>.ts` — so
 * the timestamped-filename behaviour the guard defends against is reproduced
 * faithfully. This proves a later `--with` is additive and that re-running is
 * idempotent, without a build or an Ignitor.
 */

async function exists(p: string): Promise<boolean> {
  return access(p)
    .then(() => true)
    .catch(() => false)
}

// Maps a stub path to the destination the real stub writes to. Returns null
// for stubs we don't model (none, currently).
function destinationFor(stubPath: string, root: string, nextId: () => string): string | null {
  switch (stubPath) {
    case 'config/multitenancy.stub':
      return join(root, 'config', 'multitenancy.ts')
    case 'models/tenant.stub':
      return join(root, 'app', 'models', 'backoffice', 'tenant.ts')
    case 'mailers/quota_warning_mailer.stub':
      return join(root, 'app', 'mailers', 'quota_warning_mailer.ts')
    case 'views/emails/quota_warning.edge.stub':
      return join(root, 'resources', 'views', 'emails', 'quota_warning.edge')
    default:
      if (stubPath.startsWith('migrations/')) {
        const name = stubPath.slice('migrations/'.length).replace(/\.stub$/, '')
        return join(root, 'database', 'migrations', `${nextId()}_${name}.ts`)
      }
      return null
  }
}

// Builds a fake `Configure` command rooted at `root`, selecting via --with.
function fakeCommand(root: string, withFlag: string | undefined) {
  let counter = 0
  // All-digits, monotonic, unique → mirrors `${Date.now()}_<stub>.ts` while
  // guaranteeing no two same-millisecond writes collide.
  const nextId = () => `${Date.now()}${String(counter++).padStart(4, '0')}`

  const codemods = {
    async updateRcFile(fn: (rc: any) => void) {
      fn({ addProvider() {}, addCommand() {} })
    },
    // Honours the real codemod's overwrite=false: skip when the destination
    // already exists. Migration destinations are always new (the guard upstream
    // is what prevents duplicates), config/model/mailer skip on re-run.
    async makeUsingStub(_stubsRoot: string, stubPath: string) {
      const dest = destinationFor(stubPath, root, nextId)
      if (!dest) return
      if (await exists(dest)) return
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, `// rendered from ${stubPath}\n`)
    },
  }

  return {
    app: {
      makePath: (...p: string[]) => join(root, ...p),
      migrationsPath: (...p: string[]) => join(root, 'database', 'migrations', ...p),
    },
    logger: { info() {}, warning() {}, log() {}, success() {} },
    parsed: { flags: { with: withFlag } },
    async createCodemods() {
      return codemods
    },
  } as any
}

async function listMigrations(root: string): Promise<string[]> {
  return readdir(join(root, 'database', 'migrations')).catch(() => [] as string[])
}

function matching(files: string[], stub: string): string[] {
  const re = new RegExp(`^\\d+_${stub}\\.ts$`)
  return files.filter((f) => re.test(f))
}

test.group('configure() publish orchestration', (group) => {
  let root: string

  group.each.setup(async () => {
    root = await mkdtemp(join(tmpdir(), 'lasagna-configure-'))
  })
  group.each.teardown(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test('first install publishes config, tenant model and the selected migrations', async ({
    assert,
  }) => {
    await configure(fakeCommand(root, 'audit,webhooks'))

    assert.isTrue(await exists(join(root, 'config', 'multitenancy.ts')))
    assert.isTrue(await exists(join(root, 'app', 'models', 'backoffice', 'tenant.ts')))

    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_tenant_audit_logs_table'), 1)
    assert.lengthOf(matching(migrations, 'create_tenant_webhooks_table'), 1)
    assert.lengthOf(matching(migrations, 'create_tenant_webhook_deliveries_table'), 1)
    assert.lengthOf(migrations, 3)
  })

  test('a later --with adds new satellites without touching the first ones', async ({ assert }) => {
    await configure(fakeCommand(root, 'audit,webhooks'))
    const firstRun = (await listMigrations(root)).sort()

    // Simulate a host edit to the config to prove the re-run does not overwrite.
    await appendFile(join(root, 'config', 'multitenancy.ts'), '// host edit — keep me\n')

    await configure(fakeCommand(root, 'quotas,billing,metrics'))
    const secondRun = await listMigrations(root)

    // The three original migrations survive verbatim.
    for (const f of firstRun) assert.include(secondRun, f)

    // The new satellites are published.
    assert.lengthOf(matching(secondRun, 'create_tenant_plans_table'), 1)
    assert.lengthOf(matching(secondRun, 'create_stripe_customers_table'), 1)
    assert.lengthOf(matching(secondRun, 'create_stripe_subscriptions_table'), 1)
    assert.lengthOf(matching(secondRun, 'create_stripe_processed_events_table'), 1)
    assert.lengthOf(matching(secondRun, 'create_stripe_meter_events_table'), 1)
    assert.lengthOf(matching(secondRun, 'create_tenant_metrics_table'), 1)

    // Billing also published the mailer + view.
    assert.isTrue(await exists(join(root, 'app', 'mailers', 'quota_warning_mailer.ts')))
    assert.isTrue(await exists(join(root, 'resources', 'views', 'emails', 'quota_warning.edge')))

    // The config was NOT overwritten — the host edit is still there.
    const cfg = await readFile(join(root, 'config', 'multitenancy.ts'), 'utf8')
    assert.include(cfg, 'host edit — keep me')
  })

  test('re-running the same --with adds nothing (idempotent)', async ({ assert }) => {
    await configure(fakeCommand(root, 'quotas,billing,metrics'))
    const after1 = (await listMigrations(root)).sort()

    await configure(fakeCommand(root, 'quotas,billing,metrics'))
    const after2 = (await listMigrations(root)).sort()

    assert.deepEqual(after2, after1, 'no new migration files on a second identical run')
  })

  test('quotas + billing publishes tenant_plans exactly once', async ({ assert }) => {
    await configure(fakeCommand(root, 'quotas,billing'))
    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_tenant_plans_table'), 1)
  })

  test('a bare re-run after a full install duplicates nothing', async ({ assert }) => {
    // First: explicit subset. Then: bare configure (no --with → publishes ALL
    // satellites). The guard must skip the already-present ones.
    await configure(fakeCommand(root, 'audit,webhooks'))
    await configure(fakeCommand(root, undefined))
    const migrations = await listMigrations(root)

    // Every stub appears at most once.
    for (const stub of [
      'create_tenant_audit_logs_table',
      'create_tenant_webhooks_table',
      'create_tenant_webhook_deliveries_table',
      'create_tenant_plans_table',
      'create_tenant_metrics_table',
      'create_tenant_brandings_table',
    ]) {
      assert.lengthOf(matching(migrations, stub), 1, `${stub} published exactly once`)
    }
  })
})

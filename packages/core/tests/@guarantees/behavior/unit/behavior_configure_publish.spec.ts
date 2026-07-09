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
import configure, { CORE_SCAFFOLD } from '../../../../configure.js'

/**
 * File-level test of `configure()`'s orchestration: selection → resolve → dedup
 * → idempotency guard → publish, for BOTH core bundles and external (packaged)
 * satellites. We drive the real `configure()` with a fake command whose
 * `makeUsingStub` writes the same destinations the real stubs target —
 * `database/migrations/${Date.now()}_<stub>.ts` — so the timestamped-filename
 * behaviour the guard defends against is reproduced faithfully. External
 * satellites are scaffolded as real `node_modules/<pkg>` trees so the real
 * `discoverSatellites` resolver runs (no mocking).
 */

async function exists(p: string): Promise<boolean> {
  return access(p)
    .then(() => true)
    .catch(() => false)
}

// Maps a stub path to the destination the real stub writes to. Every branch here
// mirrors an `exports({ to: … })` line in the matching `.stub`; the
// `stub_destinations_match_mock` spec below pins the two together.
function destinationFor(stubPath: string, root: string, nextId: () => string): string | null {
  if (stubPath === 'config/multitenancy.stub') return join(root, 'config', 'multitenancy.ts')
  if (stubPath === 'models/tenant.stub')
    return join(root, 'app', 'models', 'backoffice', 'tenant.ts')
  if (stubPath === 'repositories/tenant_repository.stub')
    return join(root, 'app', 'repositories', 'tenant_repository.ts')
  if (stubPath === 'providers/tenancy_provider.stub')
    return join(root, 'providers', 'tenancy_provider.ts')
  // The tenants table carries a fixed zero timestamp so it always sorts first.
  if (stubPath === 'migrations/create_tenants_table.stub')
    return join(
      root,
      'database',
      'migrations',
      `${TENANTS_MIGRATION_PREFIX}_create_tenants_table.ts`
    )
  // Core stubs are `migrations/<name>.stub`; external satellites publish via the
  // toolkit as `<migrationsDir>/<name>.stub` (e.g. `stubs/migrations/<name>.stub`).
  const m = stubPath.match(/(?:^|[\\/])migrations[\\/](.+)\.stub$/)
  if (m) return join(root, 'database', 'migrations', `${nextId()}_${m[1]}.ts`)
  return null
}

const TENANTS_MIGRATION_PREFIX = '0000000000000'
const STUBS_ROOT = new URL('../../../../stubs/', import.meta.url)

interface Captured {
  providers: string[]
  commands: string[]
  logs: string[]
  warnings: string[]
}

function fakeCommand(root: string, flags: Record<string, unknown> = {}) {
  let counter = 0
  const nextId = () => `${Date.now()}${String(counter++).padStart(4, '0')}`
  const captured: Captured = { providers: [], commands: [], logs: [], warnings: [] }

  const codemods = {
    async updateRcFile(fn: (rc: any) => void) {
      fn({
        addProvider(p: string) {
          if (!captured.providers.includes(p)) captured.providers.push(p)
        },
        addCommand(c: string) {
          if (!captured.commands.includes(c)) captured.commands.push(c)
        },
      })
    },
    async makeUsingStub(_stubsRoot: string, stubPath: string) {
      const dest = destinationFor(stubPath, root, nextId)
      if (!dest) return
      if (await exists(dest)) return
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, `// rendered from ${stubPath}\n`)
    },
  }

  const command = {
    app: {
      makePath: (...p: string[]) => join(root, ...p),
      migrationsPath: (...p: string[]) => join(root, 'database', 'migrations', ...p),
    },
    logger: {
      info: (m: string) => captured.logs.push(m),
      warning: (m: string) => captured.warnings.push(m),
      log: (m: string) => captured.logs.push(m),
      success: (m: string) => captured.logs.push(m),
      error: (m: string) => captured.warnings.push(m),
    },
    parsed: { flags },
    async createCodemods() {
      return codemods
    },
    captured,
  }
  return command as any
}

// Write a packaged satellite under <root>/node_modules/<pkg> with .stub migrations.
async function scaffoldSatellite(
  root: string,
  pkg: string,
  manifest: Record<string, unknown>,
  stubNames: string[]
): Promise<void> {
  const pkgDir = join(root, 'node_modules', ...pkg.split('/'))
  await mkdir(join(pkgDir, 'stubs', 'migrations'), { recursive: true })
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: pkg, lasagnaSatellite: manifest })
  )
  for (const name of stubNames) {
    await writeFile(join(pkgDir, 'stubs', 'migrations', `${name}.stub`), `// ${name}`)
  }
  // Ensure the host package.json lists the dep so discovery picks it up.
  const hostPkgPath = join(root, 'package.json')
  const hostPkg = (await exists(hostPkgPath))
    ? JSON.parse(await readFile(hostPkgPath, 'utf8'))
    : { name: 'host-app', dependencies: {} }
  hostPkg.dependencies = { ...hostPkg.dependencies, [pkg]: '*' }
  await writeFile(hostPkgPath, JSON.stringify(hostPkg))
}

async function listMigrations(root: string): Promise<string[]> {
  return readdir(join(root, 'database', 'migrations')).catch(() => [] as string[])
}

/**
 * The migrations a run published *because of a feature selection*. `configure`
 * always publishes the `tenants` table (it is the table the package pivots on,
 * not a feature), so the specs that assert "this selection published nothing"
 * mean nothing beyond that one.
 */
async function featureMigrations(root: string): Promise<string[]> {
  return (await listMigrations(root)).filter((f) => !/_create_tenants_table\.ts$/.test(f))
}

function matching(files: string[], stub: string): string[] {
  // Tolerate the per-package namespace prefix external satellites now get
  // (`<ts>_<slug>__<stub>.ts`) as well as the plain core form (`<ts>_<stub>.ts`).
  const re = new RegExp(`^\\d+_(?:[a-z0-9_]+__)?${stub}\\.ts$`)
  return files.filter((f) => re.test(f))
}

test.group('configure() publish orchestration — core bundles', (group) => {
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
    await configure(fakeCommand(root, { with: 'audit,webhooks' }))

    assert.isTrue(await exists(join(root, 'config', 'multitenancy.ts')))
    assert.isTrue(await exists(join(root, 'app', 'models', 'backoffice', 'tenant.ts')))

    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_tenants_table'), 1)
    assert.lengthOf(matching(migrations, 'create_tenant_audit_logs_table'), 1)
    assert.lengthOf(matching(migrations, 'create_tenant_webhooks_table'), 1)
    assert.lengthOf(matching(migrations, 'create_tenant_webhook_deliveries_table'), 1)
    assert.lengthOf(migrations, 4)
  })

  test('a later --with adds new satellites without touching the first ones', async ({ assert }) => {
    await configure(fakeCommand(root, { with: 'audit,webhooks' }))
    const firstRun = (await listMigrations(root)).sort()

    await appendFile(join(root, 'config', 'multitenancy.ts'), '// host edit — keep me\n')

    await configure(fakeCommand(root, { with: 'quotas,metrics' }))
    const secondRun = await listMigrations(root)

    for (const f of firstRun) assert.include(secondRun, f)
    assert.lengthOf(matching(secondRun, 'create_tenant_plans_table'), 1)
    assert.lengthOf(matching(secondRun, 'create_tenant_metrics_table'), 1)

    const cfg = await readFile(join(root, 'config', 'multitenancy.ts'), 'utf8')
    assert.include(cfg, 'host edit — keep me')
  })

  test('re-running the same --with adds nothing (idempotent)', async ({ assert }) => {
    await configure(fakeCommand(root, { with: 'quotas,metrics' }))
    const after1 = (await listMigrations(root)).sort()

    await configure(fakeCommand(root, { with: 'quotas,metrics' }))
    const after2 = (await listMigrations(root)).sort()

    assert.deepEqual(after2, after1, 'no new migration files on a second identical run')
  })

  test('a bare run publishes the working scaffold — no experimental satellites (B7)', async ({
    assert,
  }) => {
    const cmd = fakeCommand(root, {})
    await configure(cmd)

    // Core scaffolding is always published: the three files and the one migration
    // a working install needs. Anything less and `tenant:create` fails on a clean app.
    assert.isTrue(await exists(join(root, 'config', 'multitenancy.ts')))
    assert.isTrue(await exists(join(root, 'app', 'models', 'backoffice', 'tenant.ts')))
    assert.isTrue(await exists(join(root, 'app', 'repositories', 'tenant_repository.ts')))
    assert.isTrue(await exists(join(root, 'providers', 'tenancy_provider.ts')))
    assert.lengthOf(matching(await listMigrations(root), 'create_tenants_table'), 1)

    // …but NONE of the experimental satellite migrations are auto-published.
    assert.lengthOf(await featureMigrations(root), 0)
    assert.isTrue(
      cmd.captured.logs.some((l: string) => /no features selected/i.test(l)),
      'tells the operator nothing beyond the core scaffold was published'
    )
  })

  test('the tenants migration is stamped with a fixed zero prefix, so it always sorts first', async ({
    assert,
  }) => {
    // `add_maintenance_to_tenants_table` ALTERs the table this one CREATEs. Both
    // land in one directory and Lucid runs them in filename order, so a same-
    // millisecond `Date.now()` tie between two stubs would run the ALTER first.
    // The guarantee lives in the stub's own `exports({ to: … })` line, so assert
    // on the source rather than on the mock that imitates it.
    const stub = await readFile(new URL('migrations/create_tenants_table.stub', STUBS_ROOT), 'utf8')
    const frontmatter = stub.match(/\{\{\{([\s\S]*?)\}\}\}/)?.[1] ?? ''
    assert.include(
      frontmatter,
      `app.migrationsPath('${TENANTS_MIGRATION_PREFIX}_create_tenants_table.ts')`
    )
    assert.notInclude(frontmatter, 'Date.now()')

    // And it really is smaller than a live timestamp.
    assert.isBelow(Number(TENANTS_MIGRATION_PREFIX), Date.now())
  })

  test('every scaffold stub writes where CORE_SCAFFOLD says it does', async ({ assert }) => {
    // `configure` decides "already published?" from CORE_SCAFFOLD[].path, but the
    // file actually lands wherever the stub's `exports({ to: … })` points. Drift
    // between the two silently breaks the re-run-safety guarantee.
    // AdonisJS exposes `modelsPath`/`providersPath` for the conventional dirs and
    // `makePath` for everything else. There is no `appPath` and no
    // `repositoriesPath`; calling one that does not exist throws only when a real
    // `configure` renders the stub, which is why the clean-app CI gate exists.
    const destination = (path: string) =>
      path.startsWith('app/models/')
        ? `app.modelsPath('${path.slice('app/models/'.length)}')`
        : path.startsWith('providers/')
          ? `app.providersPath('${path.slice('providers/'.length)}')`
          : `app.makePath('${path}')`

    for (const { path, stub } of CORE_SCAFFOLD) {
      const source = await readFile(new URL(stub, STUBS_ROOT), 'utf8')
      assert.include(source, destination(path), `${stub} does not publish to ${path}`)
    }
  })

  test('a re-run never clobbers a host-edited repository or provider', async ({ assert }) => {
    await configure(fakeCommand(root, {}))
    const repo = join(root, 'app', 'repositories', 'tenant_repository.ts')
    await appendFile(repo, '// host edit — keep me\n')

    await configure(fakeCommand(root, {}))

    assert.include(await readFile(repo, 'utf8'), 'host edit — keep me')
    assert.lengthOf(matching(await listMigrations(root), 'create_tenants_table'), 1)
  })

  test('an uninstalled official satellite (billing) prints an install hint, publishes nothing', async ({
    assert,
  }) => {
    const cmd = fakeCommand(root, { with: 'billing' })
    await configure(cmd)
    assert.lengthOf(await featureMigrations(root), 0)
    assert.isTrue(
      cmd.captured.warnings.some((w: string) => w.includes('@adonisjs-lasagna/billing')),
      'warns that billing must be installed'
    )
  })
})

test.group('configure() publish orchestration — external satellites', (group) => {
  let root: string
  group.each.setup(async () => {
    root = await mkdtemp(join(tmpdir(), 'lasagna-configure-ext-'))
  })
  group.each.teardown(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const manifest = {
    name: 'acme',
    aliases: ['acme'],
    migrations: 'stubs/migrations',
    requires: ['quotas'],
    provider: '@acme/widgets/provider',
    commands: '@acme/widgets/commands',
  }
  const stubs = ['create_acme_one_table', 'create_acme_two_table']

  test('--with=<package> copies its migrations, auto-resolves requires, registers it in adonisrc', async ({
    assert,
  }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, stubs)

    const cmd = fakeCommand(root, { with: '@acme/widgets' })
    await configure(cmd)

    const migrations = await listMigrations(root)
    // The two satellite migrations…
    assert.lengthOf(matching(migrations, 'create_acme_one_table'), 1)
    assert.lengthOf(matching(migrations, 'create_acme_two_table'), 1)
    // …plus the required core `quotas` table, auto-added.
    assert.lengthOf(matching(migrations, 'create_tenant_plans_table'), 1)

    // Provider + commands registered in adonisrc.ts (plus the core provider).
    assert.include(cmd.captured.providers, '@acme/widgets/provider')
    assert.include(cmd.captured.commands, '@acme/widgets/commands')
    assert.include(
      cmd.captured.providers,
      '@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider'
    )
  })

  test('resolves the package by its manifest alias', async ({ assert }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, stubs)
    await configure(fakeCommand(root, { with: 'acme' }))
    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_acme_one_table'), 1)
  })

  test('re-running an external --with is idempotent', async ({ assert }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, stubs)
    await configure(fakeCommand(root, { with: '@acme/widgets' }))
    const after1 = (await listMigrations(root)).sort()
    await configure(fakeCommand(root, { with: '@acme/widgets' }))
    const after2 = (await listMigrations(root)).sort()
    assert.deepEqual(after2, after1)
  })

  test('--list-satellites lists installed satellites and publishes nothing', async ({ assert }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, stubs)

    const cmd = fakeCommand(root, { 'list-satellites': true })
    await configure(cmd)

    assert.isFalse(await exists(join(root, 'config', 'multitenancy.ts')))
    assert.lengthOf(await listMigrations(root), 0)
    assert.isTrue(
      cmd.captured.logs.some((l: string) => l.includes('@acme/widgets')),
      'lists the discovered satellite'
    )
  })

  test('--list-satellites with none installed says so and publishes nothing', async ({
    assert,
  }) => {
    // `root` has no package.json (no scaffold), so discovery finds nothing.
    const cmd = fakeCommand(root, { 'list-satellites': true })
    await configure(cmd)
    assert.lengthOf(await listMigrations(root), 0)
    assert.isTrue(cmd.captured.logs.some((l: string) => /none found/i.test(l)))
  })

  test('a requires entry naming an unknown core feature warns but still publishes the satellite', async ({
    assert,
  }) => {
    await scaffoldSatellite(
      root,
      '@acme/widgets',
      { name: 'acme', migrations: 'stubs/migrations', requires: ['not_a_real_bundle'] },
      ['create_acme_one_table']
    )
    const cmd = fakeCommand(root, { with: '@acme/widgets' })
    await configure(cmd)

    assert.lengthOf(matching(await listMigrations(root), 'create_acme_one_table'), 1)
    assert.isTrue(
      cmd.captured.warnings.some((w: string) => w.includes('not_a_real_bundle')),
      'warns about the unknown required feature'
    )
  })

  test('an external satellite with no migrations still registers its provider/commands', async ({
    assert,
  }) => {
    await scaffoldSatellite(
      root,
      '@acme/nomig',
      { name: 'nomig', provider: '@acme/nomig/provider', commands: '@acme/nomig/commands' },
      []
    )
    const cmd = fakeCommand(root, { with: '@acme/nomig' })
    await configure(cmd)

    assert.lengthOf(await featureMigrations(root), 0)
    assert.include(cmd.captured.providers, '@acme/nomig/provider')
    assert.include(cmd.captured.commands, '@acme/nomig/commands')
  })

  test('multiple externals in one --with are all published and registered', async ({ assert }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, ['create_acme_table'])
    await scaffoldSatellite(
      root,
      '@beta/gadgets',
      { name: 'beta', migrations: 'stubs/migrations', provider: '@beta/gadgets/provider' },
      ['create_beta_table']
    )
    const cmd = fakeCommand(root, { with: '@acme/widgets,@beta/gadgets' })
    await configure(cmd)

    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_acme_table'), 1)
    assert.lengthOf(matching(migrations, 'create_beta_table'), 1)
    assert.include(cmd.captured.providers, '@acme/widgets/provider')
    assert.include(cmd.captured.providers, '@beta/gadgets/provider')
  })

  test('a core + external mix publishes both, plus the external requires', async ({ assert }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, ['create_acme_table'])
    await configure(fakeCommand(root, { with: 'audit,@acme/widgets' }))

    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_tenant_audit_logs_table'), 1) // core
    assert.lengthOf(matching(migrations, 'create_acme_table'), 1) // external
    assert.lengthOf(matching(migrations, 'create_tenant_plans_table'), 1) // requires quotas
  })

  test('a duplicate external token (name + its own alias) is published once', async ({
    assert,
  }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, ['create_acme_table'])
    await configure(fakeCommand(root, { with: '@acme/widgets,acme' }))
    assert.lengthOf(matching(await listMigrations(root), 'create_acme_table'), 1)
  })

  test('two externals shipping a same-named stub each publish their own (namespaced, no silent skip) (B2)', async ({
    assert,
  }) => {
    await scaffoldSatellite(
      root,
      '@acme/widgets',
      { name: 'acme', migrations: 'stubs/migrations' },
      ['create_shared_table']
    )
    await scaffoldSatellite(
      root,
      '@beta/gadgets',
      { name: 'beta', migrations: 'stubs/migrations' },
      ['create_shared_table']
    )
    await configure(fakeCommand(root, { with: '@acme/widgets,@beta/gadgets' }))

    const migrations = await listMigrations(root)
    // Before B2 the second satellite was silently skipped (one file, one table).
    // Now each publishes its own namespaced migration → both tables get created.
    assert.lengthOf(matching(migrations, 'create_shared_table'), 2)
    assert.isTrue(migrations.some((f) => /_acme_widgets__create_shared_table\.ts$/.test(f)))
    assert.isTrue(migrations.some((f) => /_beta_gadgets__create_shared_table\.ts$/.test(f)))
  })

  test('re-running a namespaced external publish is idempotent (B2)', async ({ assert }) => {
    await scaffoldSatellite(
      root,
      '@acme/widgets',
      { name: 'acme', migrations: 'stubs/migrations' },
      ['create_shared_table']
    )
    await configure(fakeCommand(root, { with: '@acme/widgets' }))
    const after1 = (await listMigrations(root)).sort()
    await configure(fakeCommand(root, { with: '@acme/widgets' }))
    const after2 = (await listMigrations(root)).sort()
    assert.deepEqual(after2, after1, 'no duplicate on a second run')
  })

  test('an unknown token warns (listing core + installed) and publishes config but no feature migrations', async ({
    assert,
  }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, stubs)
    const cmd = fakeCommand(root, { with: 'totally_bogus' })
    await configure(cmd)

    assert.isTrue(await exists(join(root, 'config', 'multitenancy.ts')))
    assert.lengthOf(await featureMigrations(root), 0)
    const warned = cmd.captured.warnings.join('\n')
    assert.include(warned, 'totally_bogus')
    assert.include(warned, '@acme/widgets') // installed satellites listed in the hint
  })

  test('a bare run auto-publishes NOTHING — neither core satellites nor externals (opt-in)', async ({
    assert,
  }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, ['create_acme_table'])
    await configure(fakeCommand(root, {}))

    const migrations = await listMigrations(root)
    // B7: core config + tenant model only; no satellite migrations at all.
    assert.isTrue(await exists(join(root, 'config', 'multitenancy.ts')))
    assert.lengthOf(matching(migrations, 'create_tenant_audit_logs_table'), 0) // core NOT auto-published
    assert.lengthOf(matching(migrations, 'create_acme_table'), 0) // external NOT auto-published
  })

  test('dependsOn: pulls in the dependency, publishes both, provider order deps-first (B3)', async ({
    assert,
  }) => {
    await scaffoldSatellite(
      root,
      '@me/app',
      {
        name: 'app',
        provider: '@me/app/provider',
        migrations: 'stubs/migrations',
        dependsOn: ['@me/lib'],
      },
      ['create_app_table']
    )
    await scaffoldSatellite(
      root,
      '@me/lib',
      { name: 'lib', provider: '@me/lib/provider', migrations: 'stubs/migrations' },
      ['create_lib_table']
    )

    const cmd = fakeCommand(root, { with: '@me/app' }) // only the dependent selected
    await configure(cmd)

    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_app_table'), 1)
    assert.lengthOf(matching(migrations, 'create_lib_table'), 1) // dependency pulled in
    // dependency's provider is registered before the dependent's
    const li = cmd.captured.providers.indexOf('@me/lib/provider')
    const ai = cmd.captured.providers.indexOf('@me/app/provider')
    assert.isAbove(li, -1)
    assert.isAbove(ai, li, 'lib provider registered before app provider')
  })

  test('dependsOn: a missing dependency fails the batch and publishes no external (B3)', async ({
    assert,
  }) => {
    await scaffoldSatellite(
      root,
      '@me/app',
      { name: 'app', migrations: 'stubs/migrations', dependsOn: ['@me/ghost'] },
      ['create_app_table']
    )
    const cmd = fakeCommand(root, { with: '@me/app' })
    await configure(cmd)

    assert.lengthOf(matching(await listMigrations(root), 'create_app_table'), 0)
    assert.isTrue(
      cmd.captured.warnings.some((w: string) => w.includes('@me/ghost')),
      'errors that the dependency is not installed'
    )
  })

  test('a dependency refused by the ABI gate also drops its dependent (B1 + B3)', async ({
    assert,
  }) => {
    // @me/app dependsOn @me/lib; @me/lib needs a newer ABI than this core, so it
    // is refused — and @me/app must NOT be wired against a dependency that was
    // rejected.
    await scaffoldSatellite(
      root,
      '@me/app',
      {
        name: 'app',
        provider: '@me/app/provider',
        migrations: 'stubs/migrations',
        dependsOn: ['@me/lib'],
      },
      ['create_app_table']
    )
    await scaffoldSatellite(
      root,
      '@me/lib',
      {
        name: 'lib',
        satelliteApi: 999,
        provider: '@me/lib/provider',
        migrations: 'stubs/migrations',
      },
      ['create_lib_table']
    )

    const cmd = fakeCommand(root, { with: '@me/app' })
    await configure(cmd)

    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_lib_table'), 0) // ABI-refused
    assert.lengthOf(matching(migrations, 'create_app_table'), 0) // dependent dropped too
    assert.notInclude(cmd.captured.providers, '@me/app/provider')
    assert.notInclude(cmd.captured.providers, '@me/lib/provider')
    assert.isTrue(
      cmd.captured.warnings.some((w: string) => /@me\/app/.test(w) && /@me\/lib/.test(w)),
      'explains the dependent was dropped because its dependency was refused'
    )
  })

  test('interactive TTY selection splits core bundles from external satellites', async ({
    assert,
  }) => {
    await scaffoldSatellite(root, '@acme/widgets', manifest, ['create_acme_table'])

    const cmd = fakeCommand(root, {}) // no --with → interactive branch
    cmd.prompt = {
      async multiple() {
        return ['audit', '@acme/widgets'] // one core bundle + one external satellite
      },
    }

    const originalIsTTY = process.stdout.isTTY
    try {
      process.stdout.isTTY = true
      await configure(cmd)
    } finally {
      process.stdout.isTTY = originalIsTTY
    }

    const migrations = await listMigrations(root)
    assert.lengthOf(matching(migrations, 'create_tenant_audit_logs_table'), 1) // core pick
    assert.lengthOf(matching(migrations, 'create_acme_table'), 1) // external pick
    assert.lengthOf(matching(migrations, 'create_tenant_plans_table'), 1) // acme requires quotas
    assert.include(cmd.captured.providers, '@acme/widgets/provider')
    // NOT-selected core bundles must not be published.
    assert.lengthOf(matching(migrations, 'create_tenant_metrics_table'), 0)
  })
})

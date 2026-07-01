import { test } from '@japa/runner'
import { mkdtemp, rm, mkdir, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSatelliteManifest, isSafeRelativePath } from '../../../../src/sdk/manifest.js'
import type { DiscoveredSatellite } from '../../../../src/sdk/manifest.js'
import {
  discoverSatellites,
  indexSatellites,
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  filterAlreadyPublished,
  migrationSlug,
  satelliteMigrationDirs,
} from '../../../../src/sdk/configure_kit.js'

/* ════════════════════════ Layer 1 — manifest parser ════════════════════════ */

test.group('satellite — readSatelliteManifest', () => {
  test('returns null when the key is absent or not a plain object', ({ assert }) => {
    assert.isNull(readSatelliteManifest({ name: 'x' }))
    assert.isNull(readSatelliteManifest(null))
    assert.isNull(readSatelliteManifest(undefined))
    assert.isNull(readSatelliteManifest(42))
    assert.isNull(readSatelliteManifest('nope'))
    assert.isNull(readSatelliteManifest({ lasagnaSatellite: [] }))
    assert.isNull(readSatelliteManifest({ lasagnaSatellite: 'string' }))
    assert.isNull(readSatelliteManifest({ lasagnaSatellite: 7 }))
    assert.isNull(readSatelliteManifest({ lasagnaSatellite: true }))
  })

  test('parses a full manifest', ({ assert }) => {
    const m = readSatelliteManifest({
      name: '@me/sat',
      lasagnaSatellite: {
        name: 'sat',
        satelliteApi: 1,
        aliases: ['s'],
        migrations: 'stubs/migrations',
        perTenantMigrations: 'build/tenant_migrations',
        requires: ['quotas'],
        provider: '@me/sat/provider',
        commands: '@me/sat/commands',
        env: ['FOO'],
        install: ['npm i @me/sat'],
        configSnippet: 'sat: {}',
        docs: 'https://x',
      },
    })
    assert.deepEqual(m, {
      name: 'sat',
      satelliteApi: 1,
      aliases: ['s'],
      migrations: 'stubs/migrations',
      perTenantMigrations: 'build/tenant_migrations',
      requires: ['quotas'],
      provider: '@me/sat/provider',
      commands: '@me/sat/commands',
      env: ['FOO'],
      install: ['npm i @me/sat'],
      configSnippet: 'sat: {}',
      docs: 'https://x',
    })
  })

  test('satelliteApi: keeps a positive integer, drops anything else with a warning', ({
    assert,
  }) => {
    assert.equal(
      readSatelliteManifest({ name: '@me/s', lasagnaSatellite: { name: 's', satelliteApi: 2 } })
        ?.satelliteApi,
      2
    )
    // absent → undefined, no warning
    const noWarn: string[] = []
    assert.isUndefined(
      readSatelliteManifest({ name: '@me/s', lasagnaSatellite: { name: 's' } }, (w) =>
        noWarn.push(w)
      )?.satelliteApi
    )
    assert.lengthOf(noWarn, 0)
    // invalid (0, negative, float, non-number) → dropped + warned, manifest survives
    for (const bad of [0, -1, 1.5, '1', null, {}]) {
      const warnings: string[] = []
      const m = readSatelliteManifest(
        { name: '@me/s', lasagnaSatellite: { name: 's', satelliteApi: bad } },
        (w) => warnings.push(w)
      )
      assert.equal(m?.name, 's')
      assert.isUndefined(m?.satelliteApi, `satelliteApi=${JSON.stringify(bad)} should be dropped`)
      assert.lengthOf(warnings, 1)
    }
  })

  test('requires a non-empty name, warning and returning null without it', ({ assert }) => {
    for (const bad of [{ migrations: 'stubs/migrations' }, { name: '' }, { name: 42 }]) {
      const warnings: string[] = []
      const m = readSatelliteManifest({ name: '@me/sat', lasagnaSatellite: bad }, (w) =>
        warnings.push(w)
      )
      assert.isNull(m)
      assert.lengthOf(warnings, 1)
    }
  })

  test('drops a path-traversing or empty migrations dir with a warning', ({ assert }) => {
    for (const bad of ['../../../../etc', '..\\evil', 'a\\..\\b', '/abs', '', 'C:\\win']) {
      const warnings: string[] = []
      const m = readSatelliteManifest(
        { name: '@me/sat', lasagnaSatellite: { name: 'sat', migrations: bad } },
        (w) => warnings.push(w)
      )
      assert.equal(m?.name, 'sat')
      assert.isUndefined(m?.migrations, `migrations="${bad}" should be dropped`)
      assert.lengthOf(warnings, 1)
    }
  })

  test('keeps a safe perTenantMigrations dir and drops an unsafe one (SEAM-2)', ({ assert }) => {
    // A valid relative dir survives.
    const ok = readSatelliteManifest({
      name: '@me/sat',
      lasagnaSatellite: { name: 'sat', perTenantMigrations: 'build/tenant_migrations' },
    })
    assert.equal(ok?.perTenantMigrations, 'build/tenant_migrations')
    // The same path-traversal / absolute rejections as `migrations`.
    for (const bad of ['../../../../etc', '..\\evil', 'a\\..\\b', '/abs', '', 'C:\\win']) {
      const warnings: string[] = []
      const m = readSatelliteManifest(
        { name: '@me/sat', lasagnaSatellite: { name: 'sat', perTenantMigrations: bad } },
        (w) => warnings.push(w)
      )
      assert.equal(m?.name, 'sat')
      assert.isUndefined(m?.perTenantMigrations, `perTenantMigrations="${bad}" should be dropped`)
      assert.lengthOf(warnings, 1)
    }
  })

  test('drops non-string provider / commands / configSnippet / docs but keeps the manifest', ({
    assert,
  }) => {
    const m = readSatelliteManifest({
      name: '@me/sat',
      lasagnaSatellite: {
        name: 'sat',
        provider: 42,
        commands: {},
        configSnippet: ['x'],
        docs: true,
      },
    })
    assert.equal(m?.name, 'sat')
    assert.isUndefined(m?.provider)
    assert.isUndefined(m?.commands)
    assert.isUndefined(m?.configSnippet)
    assert.isUndefined(m?.docs)
  })

  test('drops a path-traversing or absolute provider / commands with a warning (B6)', ({
    assert,
  }) => {
    for (const key of ['provider', 'commands'] as const) {
      for (const bad of ['../evil', '/abs/evil', 'a/../b', 'C:\\win', '\\unc']) {
        const warnings: string[] = []
        const m = readSatelliteManifest(
          { name: '@me/sat', lasagnaSatellite: { name: 'sat', [key]: bad } },
          (w) => warnings.push(w)
        )
        assert.equal(m?.name, 'sat')
        assert.isUndefined(m?.[key], `${key}="${bad}" should be dropped`)
        assert.lengthOf(warnings, 1)
      }
    }
    // a normal package subpath specifier is kept (no `..`, not absolute)
    const ok = readSatelliteManifest({
      name: '@me/sat',
      lasagnaSatellite: { name: 'sat', provider: '@me/sat/provider', commands: '@me/sat/commands' },
    })
    assert.equal(ok?.provider, '@me/sat/provider')
    assert.equal(ok?.commands, '@me/sat/commands')
  })

  test('dependsOn: accepts string shorthand + { pkg, range }, drops invalid entries (B3)', ({
    assert,
  }) => {
    const m = readSatelliteManifest({
      name: '@me/sat',
      lasagnaSatellite: {
        name: 'sat',
        dependsOn: ['@me/a', { pkg: '@me/b', range: '^1.0.0' }, { pkg: '@me/c' }],
      },
    })
    assert.deepEqual(m?.dependsOn, [
      { pkg: '@me/a' },
      { pkg: '@me/b', range: '^1.0.0' },
      { pkg: '@me/c' },
    ])

    // invalid entries are dropped with a warning; a valid one survives
    const warnings: string[] = []
    const m2 = readSatelliteManifest(
      {
        name: '@me/sat',
        lasagnaSatellite: { name: 'sat', dependsOn: ['', 42, { range: 'x' }, '@me/ok'] },
      },
      (w) => warnings.push(w)
    )
    assert.deepEqual(m2?.dependsOn, [{ pkg: '@me/ok' }])
    assert.isAbove(warnings.length, 0)

    // non-array → dropped with a warning
    const warn2: string[] = []
    const m3 = readSatelliteManifest(
      { name: '@me/sat', lasagnaSatellite: { name: 'sat', dependsOn: 'nope' } },
      (w) => warn2.push(w)
    )
    assert.isUndefined(m3?.dependsOn)
    assert.lengthOf(warn2, 1)
  })

  test('string-array fields: empty → dropped; mixed → only strings kept; non-array → dropped', ({
    assert,
  }) => {
    const m = readSatelliteManifest({
      name: '@me/sat',
      lasagnaSatellite: {
        name: 'sat',
        aliases: [],
        requires: ['quotas', 7, null, 'plans'],
        env: 'nope',
        install: [{}, 'npm i'],
      },
    })
    assert.isUndefined(m?.aliases) // empty → undefined
    assert.deepEqual(m?.requires, ['quotas', 'plans']) // non-strings filtered
    assert.isUndefined(m?.env) // non-array → undefined
    assert.deepEqual(m?.install, ['npm i'])
  })

  test('a __proto__ key in the manifest does not pollute Object.prototype', ({ assert }) => {
    const raw = JSON.parse(
      '{"name":"@me/sat","lasagnaSatellite":{"name":"sat","__proto__":{"polluted":true}}}'
    )
    readSatelliteManifest(raw)
    assert.isUndefined(({} as Record<string, unknown>).polluted)
  })

  test('isSafeRelativePath matrix', ({ assert }) => {
    // safe
    assert.isTrue(isSafeRelativePath('stubs/migrations'))
    assert.isTrue(isSafeRelativePath('.')) // current dir, no escape
    assert.isTrue(isSafeRelativePath('..foo')) // a filename starting with .., not a `..` segment
    assert.isTrue(isSafeRelativePath('a/b/c'))
    // unsafe
    assert.isFalse(isSafeRelativePath(''))
    assert.isFalse(isSafeRelativePath('/etc/passwd'))
    assert.isFalse(isSafeRelativePath('\\leading'))
    assert.isFalse(isSafeRelativePath('../escape'))
    assert.isFalse(isSafeRelativePath('a/../b'))
    assert.isFalse(isSafeRelativePath('a\\..\\b'))
    assert.isFalse(isSafeRelativePath('C:\\windows'))
    assert.isFalse(isSafeRelativePath(42 as unknown as string))
  })
})

/* ════════════════════════ Layer 2 — discovery + toolkit ════════════════════ */

// Build a temp host app with a node_modules tree so discovery runs for real.
async function scaffoldHost(): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'lasagna-discover-'))
  await writeFile(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'host-app',
      dependencies: { '@fake/sat': '*', 'not-a-sat': '*', 'ghost-dep': '*' },
      devDependencies: { '@fake/devsat': '*', '@fake/sat': '*' /* also a prod dep */ },
    })
  )

  const fakeSat = join(root, 'node_modules', '@fake', 'sat')
  await mkdir(join(fakeSat, 'stubs', 'migrations'), { recursive: true })
  await writeFile(
    join(fakeSat, 'package.json'),
    JSON.stringify({
      name: '@fake/sat',
      lasagnaSatellite: {
        name: 'fake',
        aliases: ['fake'],
        migrations: 'stubs/migrations',
        requires: ['quotas'],
      },
    })
  )
  await writeFile(join(fakeSat, 'stubs', 'migrations', 'create_fake_one_table.stub'), '// one')
  await writeFile(join(fakeSat, 'stubs', 'migrations', 'create_fake_two_table.stub'), '// two')

  const devSat = join(root, 'node_modules', '@fake', 'devsat')
  await mkdir(devSat, { recursive: true })
  await writeFile(
    join(devSat, 'package.json'),
    JSON.stringify({ name: '@fake/devsat', lasagnaSatellite: { name: 'devsat' } })
  )

  const notSat = join(root, 'node_modules', 'not-a-sat')
  await mkdir(notSat, { recursive: true })
  await writeFile(join(notSat, 'package.json'), JSON.stringify({ name: 'not-a-sat' }))

  // `ghost-dep` is listed in package.json but NOT installed (no node_modules entry).
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) }
}

test.group('satellite — discoverSatellites', (group) => {
  let host: { root: string; cleanup: () => Promise<void> }
  group.each.setup(async () => {
    host = await scaffoldHost()
  })
  group.each.teardown(async () => host.cleanup())

  test('finds manifested deps (incl. devDependencies), skips non-satellites + uninstalled deps', async ({
    assert,
  }) => {
    const found = await discoverSatellites(host.root)
    const names = found.map((s) => s.packageName).sort()
    // @fake/sat appears in both deps + devDeps → discovered exactly once.
    assert.deepEqual(names, ['@fake/devsat', '@fake/sat'])
    const sat = found.find((s) => s.packageName === '@fake/sat')!
    assert.equal(sat.manifest.name, 'fake')
    assert.deepEqual(sat.manifest.requires, ['quotas'])
  })

  test('skips a dep with a malformed package.json (no throw)', async ({ assert }) => {
    await writeFile(
      join(host.root, 'node_modules', 'not-a-sat', 'package.json'),
      '{ this is not json'
    )
    const found = await discoverSatellites(host.root)
    // still resolves the good ones, silently drops the broken dep.
    assert.includeMembers(
      found.map((s) => s.packageName),
      ['@fake/sat', '@fake/devsat']
    )
  })

  test('resolves a package whose exports map hides ./package.json (the real-package shape)', async ({
    assert,
  }) => {
    // The official packages (billing/sso/...) declare `exports` WITHOUT a
    // `./package.json` entry, so `require.resolve('<pkg>/package.json')` throws
    // and discovery must fall back to resolving the entry + walking up. If that
    // fallback regresses, discovery silently finds nothing.
    const root = await mkdtemp(join(tmpdir(), 'lasagna-exports-'))
    try {
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ name: 'host', dependencies: { '@fake/exported': '*' } })
      )
      const pkgDir = join(root, 'node_modules', '@fake', 'exported')
      await mkdir(join(pkgDir, 'stubs', 'migrations'), { recursive: true })
      await writeFile(
        join(pkgDir, 'package.json'),
        JSON.stringify({
          name: '@fake/exported',
          type: 'module',
          exports: { '.': './index.js' }, // NO "./package.json"
          lasagnaSatellite: { name: 'exported', migrations: 'stubs/migrations' },
        })
      )
      await writeFile(join(pkgDir, 'index.js'), 'export default {}\n')
      await writeFile(join(pkgDir, 'stubs', 'migrations', 'create_x_table.stub'), '// x')

      const found = await discoverSatellites(root)
      assert.lengthOf(found, 1)
      assert.equal(found[0].packageName, '@fake/exported')
      assert.equal(found[0].manifest.name, 'exported')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('returns [] for a host with no package.json, and for one with no deps', async ({
    assert,
  }) => {
    const empty = await mkdtemp(join(tmpdir(), 'lasagna-empty-'))
    const noDeps = await mkdtemp(join(tmpdir(), 'lasagna-nodeps-'))
    try {
      assert.deepEqual(await discoverSatellites(empty), [])
      await writeFile(join(noDeps, 'package.json'), JSON.stringify({ name: 'x' }))
      assert.deepEqual(await discoverSatellites(noDeps), [])
    } finally {
      await rm(empty, { recursive: true, force: true })
      await rm(noDeps, { recursive: true, force: true })
    }
  })
})

test.group('satellite — indexSatellites', () => {
  function sat(packageName: string, aliases?: string[]): DiscoveredSatellite {
    return { packageName, root: '/tmp', manifest: { name: packageName, aliases } }
  }

  test('keys by package name and alias', ({ assert }) => {
    const index = indexSatellites([sat('@me/a', ['a'])])
    assert.equal(index.get('@me/a')?.packageName, '@me/a')
    assert.equal(index.get('a')?.packageName, '@me/a')
  })

  test('a shared alias resolves to the first satellite (no clobber)', ({ assert }) => {
    const index = indexSatellites([sat('@me/a', ['shared']), sat('@me/b', ['shared'])])
    assert.equal(index.get('shared')?.packageName, '@me/a')
  })

  test('a package name always wins over another satellite using it as an alias', ({ assert }) => {
    // @me/b lists "@me/a" as an alias; @me/a's own package name must still win.
    const index = indexSatellites([sat('@me/b', ['@me/a']), sat('@me/a')])
    assert.equal(index.get('@me/a')?.packageName, '@me/a')
  })
})

test.group('satellite — publishSatellite', (group) => {
  let host: { root: string; cleanup: () => Promise<void> }
  group.each.setup(async () => {
    host = await scaffoldHost()
  })
  group.each.teardown(async () => host.cleanup())

  // A codemods double that records its makeUsingStub calls AND writes exactly
  // what a stub's `exports({ to })` emits — `<ts>_<basename>.ts` into the host
  // migrations dir — so publishSatellite's read-back + namespacing runs for real.
  function writingCodemods(migrationsDir: string) {
    const stubCalls: Array<{ stubsRoot: string; stubPath: string }> = []
    let n = 0
    return {
      stubCalls,
      async makeUsingStub(stubsRoot: string, stubPath: string) {
        stubCalls.push({ stubsRoot, stubPath })
        const base = stubPath.replace(/^.*[\\/]/, '').replace(/\.stub$/, '')
        await writeFile(join(migrationsDir, `${1700000000000 + n++}_${base}.ts`), `// ${base}`)
      },
      async updateRcFile() {},
    }
  }

  async function hostMigrations(): Promise<string> {
    const dir = join(host.root, 'database', 'migrations')
    await mkdir(dir, { recursive: true })
    return dir
  }

  test('publishes every stub when the host has none, idempotent on re-run', async ({ assert }) => {
    const found = await discoverSatellites(host.root)
    const sat = found.find((s) => s.packageName === '@fake/sat')!
    const migrationsDir = await hostMigrations()

    const codemods = writingCodemods(migrationsDir)
    const first = await publishSatellite(codemods, sat, migrationsDir)
    assert.deepEqual(first.published.sort(), ['create_fake_one_table', 'create_fake_two_table'])
    assert.lengthOf(first.skipped, 0)
    assert.lengthOf(codemods.stubCalls, 2)
    assert.equal(codemods.stubCalls[0].stubsRoot, sat.root)
    assert.match(codemods.stubCalls[0].stubPath, /^stubs[\\/]migrations[\\/]create_fake_/)
    // Emitted files are namespaced by the satellite's package slug.
    const files1 = (await readdir(migrationsDir)).sort()
    assert.lengthOf(files1, 2)
    assert.isTrue(
      files1.every((f) => /^\d+_fake_sat__create_fake_(one|two)_table\.ts$/.test(f)),
      `namespaced: ${files1.join(', ')}`
    )

    // Re-run sees its own published files and skips both — no duplicates.
    const codemods2 = writingCodemods(migrationsDir)
    const second = await publishSatellite(codemods2, sat, migrationsDir)
    assert.deepEqual(second.published, [])
    assert.deepEqual(second.skipped.sort(), ['create_fake_one_table', 'create_fake_two_table'])
    assert.lengthOf(codemods2.stubCalls, 0)
    assert.lengthOf(await readdir(migrationsDir), 2)
  })

  test('a satellite with no migrations publishes nothing', async ({ assert }) => {
    const found = await discoverSatellites(host.root)
    const devsat = found.find((s) => s.packageName === '@fake/devsat')!
    const migrationsDir = await hostMigrations()
    const codemods = writingCodemods(migrationsDir)
    const result = await publishSatellite(codemods, devsat, migrationsDir)
    assert.deepEqual(result.published, [])
    assert.lengthOf(codemods.stubCalls, 0)
  })

  test('ignores non-.stub files (only .stub is published)', async ({ assert }) => {
    const found = await discoverSatellites(host.root)
    const sat = found.find((s) => s.packageName === '@fake/sat')!
    const dir = join(sat.root, 'stubs', 'migrations')
    await writeFile(join(dir, 'create_raw_table.ts'), '// raw ts — must be ignored')
    await writeFile(join(dir, 'create_raw_table.sql'), '-- raw sql — must be ignored')
    await writeFile(join(dir, 'README.md'), '# notes')

    const migrationsDir = await hostMigrations()
    const codemods = writingCodemods(migrationsDir)
    const result = await publishSatellite(codemods, sat, migrationsDir)
    assert.deepEqual(result.published.sort(), ['create_fake_one_table', 'create_fake_two_table'])
    assert.lengthOf(codemods.stubCalls, 2)
  })

  test('returns empty when the migrations dir does not exist (no throw)', async ({ assert }) => {
    const sat: DiscoveredSatellite = {
      packageName: '@fake/missing',
      root: host.root,
      manifest: { name: 'missing', migrations: 'stubs/migrations' },
    }
    const migrationsDir = await hostMigrations()
    const codemods = writingCodemods(migrationsDir)
    const result = await publishSatellite(codemods, sat, migrationsDir)
    assert.deepEqual(result, { published: [], skipped: [] })
    assert.lengthOf(codemods.stubCalls, 0)
  })

  test('throws when the migrations dir escapes the package root', async ({ assert }) => {
    const sat: DiscoveredSatellite = {
      packageName: '@evil/pkg',
      root: host.root,
      manifest: { name: 'evil', migrations: '../escape' },
    }
    const migrationsDir = await hostMigrations()
    await assert.rejects(async () => {
      await publishSatellite(writingCodemods(migrationsDir), sat, migrationsDir)
    }, /escapes the package root/)
  })
})

test.group('satellite — publishSatellite namespacing (B2)', () => {
  // A codemods double that writes exactly what a stub's `exports({ to })` emits:
  // `<ts>_<basename>.ts` into the host migrations dir.
  function writingCodemods(migrationsDir: string) {
    let n = 0
    return {
      async makeUsingStub(_root: string, stubPath: string) {
        const base = stubPath.replace(/^.*[\\/]/, '').replace(/\.stub$/, '')
        await writeFile(join(migrationsDir, `${1700000000000 + n++}_${base}.ts`), `// ${base}`)
      },
      async updateRcFile() {},
    }
  }

  async function scaffold(dir: string, stub: string) {
    const pkgRoot = join(dir, 'pkg')
    await mkdir(join(pkgRoot, 'stubs', 'migrations'), { recursive: true })
    await writeFile(join(pkgRoot, 'stubs', 'migrations', `${stub}.stub`), '// s')
    const migrationsDir = join(dir, 'migrations')
    await mkdir(migrationsDir, { recursive: true })
    const sat: DiscoveredSatellite = {
      packageName: '@acme/widgets',
      root: pkgRoot,
      manifest: { name: 'acme', migrations: 'stubs/migrations' },
    }
    return { migrationsDir, sat }
  }

  test('migrationSlug sanitizes a scoped package name', ({ assert }) => {
    assert.equal(migrationSlug('@adonisjs-lasagna/billing'), 'adonisjs_lasagna_billing')
    assert.equal(migrationSlug('@me/My.Pkg'), 'me_my_pkg')
  })

  test('namespaces the emitted file by package; idempotent on re-run', async ({ assert }) => {
    const dir = await mkdtemp(join(tmpdir(), 'lasagna-ns-'))
    try {
      const { migrationsDir, sat } = await scaffold(dir, 'create_shared_table')
      const cm = writingCodemods(migrationsDir)

      const first = await publishSatellite(cm, sat, migrationsDir)
      assert.deepEqual(first.published, ['create_shared_table'])
      const files = await readdir(migrationsDir)
      assert.lengthOf(files, 1)
      assert.match(files[0], /^\d+_acme_widgets__create_shared_table\.ts$/)

      const second = await publishSatellite(cm, sat, migrationsDir)
      assert.deepEqual(second.skipped, ['create_shared_table'])
      assert.lengthOf(await readdir(migrationsDir), 1) // no duplicate
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('recognizes a legacy un-namespaced file (no duplicate on upgrade)', async ({ assert }) => {
    const dir = await mkdtemp(join(tmpdir(), 'lasagna-ns2-'))
    try {
      const { migrationsDir, sat } = await scaffold(dir, 'create_legacy_table')
      // simulate a pre-B2 install: a legacy file with no slug prefix
      await writeFile(join(migrationsDir, '1700000000000_create_legacy_table.ts'), '// legacy')

      const res = await publishSatellite(writingCodemods(migrationsDir), sat, migrationsDir)
      assert.deepEqual(res.skipped, ['create_legacy_table'])
      assert.lengthOf(await readdir(migrationsDir), 1) // no duplicate
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test('a different package with the same basename is NOT skipped (its own namespaced file)', async ({
    assert,
  }) => {
    const dir = await mkdtemp(join(tmpdir(), 'lasagna-ns3-'))
    try {
      const { migrationsDir, sat } = await scaffold(dir, 'create_shared_table') // @acme/widgets
      await publishSatellite(writingCodemods(migrationsDir), sat, migrationsDir)

      // A different satellite shipping the SAME stub basename must still publish.
      const sat2: DiscoveredSatellite = { ...sat, packageName: '@beta/gadgets' }
      const res = await publishSatellite(writingCodemods(migrationsDir), sat2, migrationsDir)
      assert.deepEqual(res.published, ['create_shared_table'])
      assert.lengthOf(res.skipped, 0)

      const files = (await readdir(migrationsDir)).sort()
      assert.lengthOf(files, 2)
      assert.isTrue(files.some((f) => /_acme_widgets__create_shared_table\.ts$/.test(f)))
      assert.isTrue(files.some((f) => /_beta_gadgets__create_shared_table\.ts$/.test(f)))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test.group('satellite — registerSatelliteInRcFile', () => {
  function fakeCodemods() {
    const providers: string[] = []
    const commands: string[] = []
    let updateCalls = 0
    return {
      providers,
      commands,
      get updateCalls() {
        return updateCalls
      },
      async updateRcFile(cb: (rc: any) => void) {
        updateCalls++
        cb({
          addProvider: (p: string) => providers.push(p),
          addCommand: (c: string) => commands.push(c),
        })
      },
      async makeUsingStub() {},
    }
  }

  test('does nothing when neither provider nor commands are set', async ({ assert }) => {
    const codemods = fakeCodemods()
    await registerSatelliteInRcFile(codemods, { name: 'x' })
    assert.equal(codemods.updateCalls, 0)
  })

  test('registers provider only', async ({ assert }) => {
    const codemods = fakeCodemods()
    await registerSatelliteInRcFile(codemods, { name: 'x', provider: '@x/provider' })
    assert.deepEqual(codemods.providers, ['@x/provider'])
    assert.deepEqual(codemods.commands, [])
  })

  test('registers commands only', async ({ assert }) => {
    const codemods = fakeCodemods()
    await registerSatelliteInRcFile(codemods, { name: 'x', commands: '@x/commands' })
    assert.deepEqual(codemods.providers, [])
    assert.deepEqual(codemods.commands, ['@x/commands'])
  })

  test('registers both', async ({ assert }) => {
    const codemods = fakeCodemods()
    await registerSatelliteInRcFile(codemods, {
      name: 'x',
      provider: '@x/provider',
      commands: '@x/commands',
    })
    assert.deepEqual(codemods.providers, ['@x/provider'])
    assert.deepEqual(codemods.commands, ['@x/commands'])
  })
})

test.group('satellite — printSatelliteManifest', () => {
  function fakeLogger() {
    const lines: string[] = []
    return { lines, log: (m: string) => lines.push(m), info: () => {}, warning: () => {} }
  }

  test('emits requires / install / env / configSnippet / docs', ({ assert }) => {
    const logger = fakeLogger()
    printSatelliteManifest(logger, {
      name: 'billing',
      requires: ['quotas'],
      install: ['npm i @x/billing'],
      env: ['STRIPE_API_KEY'],
      configSnippet: 'billing: {\n  driver: "stripe",\n}',
      docs: 'https://docs',
    })
    const text = logger.lines.join('\n')
    assert.include(text, 'billing satellite')
    assert.include(text, 'Requires core feature(s): quotas')
    assert.include(text, '--with=quotas')
    assert.include(text, 'npm i @x/billing')
    assert.include(text, 'STRIPE_API_KEY')
    assert.include(text, 'driver: "stripe"') // multi-line snippet split + printed
    assert.include(text, 'https://docs')
  })

  test('a bare manifest prints only the header', ({ assert }) => {
    const logger = fakeLogger()
    printSatelliteManifest(logger, { name: 'minimal' })
    const nonEmpty = logger.lines.filter((l) => l.trim().length > 0)
    assert.lengthOf(nonEmpty, 1)
    assert.include(nonEmpty[0], 'minimal satellite')
  })
})

test.group('satellite — filterAlreadyPublished (idempotency guard)', () => {
  test('publishes everything when the migrations dir is empty', ({ assert }) => {
    const { toPublish, skipped } = filterAlreadyPublished(['create_a_table', 'create_b_table'], [])
    assert.deepEqual(toPublish, ['create_a_table', 'create_b_table'])
    assert.deepEqual(skipped, [])
  })

  test('skips a stub already present under any timestamp prefix', ({ assert }) => {
    const { toPublish, skipped } = filterAlreadyPublished(
      ['create_a_table', 'create_b_table'],
      ['1700000000000_create_a_table.ts']
    )
    assert.deepEqual(skipped, ['create_a_table'])
    assert.deepEqual(toPublish, ['create_b_table'])
  })

  test('matches the full stub name, not a prefix (no false positives)', ({ assert }) => {
    const { toPublish, skipped } = filterAlreadyPublished(
      ['create_tenant_webhook_deliveries_table'],
      ['1700000000001_create_tenant_webhooks_table.ts']
    )
    assert.deepEqual(skipped, [])
    assert.deepEqual(toPublish, ['create_tenant_webhook_deliveries_table'])
  })

  test('ignores files that do not match the <digits>_<stub>.ts shape', ({ assert }) => {
    const { toPublish, skipped } = filterAlreadyPublished(
      ['create_a_table'],
      ['create_a_table.ts', 'README.md', '.gitkeep', '1700_create_a_table.sql']
    )
    assert.deepEqual(skipped, [])
    assert.deepEqual(toPublish, ['create_a_table'])
  })
})

test.group('satellite — satelliteMigrationDirs (SEAM-2)', () => {
  const sat = (root: string, perTenantMigrations?: string): DiscoveredSatellite => ({
    packageName: '@x/s',
    root,
    manifest: { name: 's', ...(perTenantMigrations ? { perTenantMigrations } : {}) },
  })

  test('emits host-relative, forward-slashed per-tenant dirs (never absolute)', ({ assert }) => {
    const hostRoot = join('/host', 'app')
    const dirs = satelliteMigrationDirs(hostRoot, [
      sat(join(hostRoot, 'node_modules', '@x', 'ai'), 'build/tenant_migrations'),
    ])
    assert.deepEqual(dirs, ['node_modules/@x/ai/build/tenant_migrations'])
    // Lucid resolves each via new URL(dir, appRoot); an absolute path (or a
    // Windows drive letter) would break that, so the result must stay relative.
    assert.isFalse(dirs[0].startsWith('/'), 'not absolute')
    assert.notMatch(dirs[0], /^[a-zA-Z]:/, 'no drive letter')
    assert.notMatch(dirs[0], /\\/, 'forward slashes only')
  })

  test('skips satellites that declare no perTenantMigrations', ({ assert }) => {
    const hostRoot = join('/host', 'app')
    const dirs = satelliteMigrationDirs(hostRoot, [
      sat(join(hostRoot, 'node_modules', 'a')),
      sat(join(hostRoot, 'node_modules', 'b'), 'build/tenant'),
    ])
    assert.deepEqual(dirs, ['node_modules/b/build/tenant'])
  })
})

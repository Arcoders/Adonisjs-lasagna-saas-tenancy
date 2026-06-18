import { test } from '@japa/runner'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readSatelliteManifest, isSafeRelativePath } from '../../../src/sdk/manifest.js'
import type { DiscoveredSatellite } from '../../../src/sdk/manifest.js'
import {
  discoverSatellites,
  indexSatellites,
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  filterAlreadyPublished,
} from '../../../src/sdk/configure_kit.js'

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
        aliases: ['s'],
        migrations: 'stubs/migrations',
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
      aliases: ['s'],
      migrations: 'stubs/migrations',
      requires: ['quotas'],
      provider: '@me/sat/provider',
      commands: '@me/sat/commands',
      env: ['FOO'],
      install: ['npm i @me/sat'],
      configSnippet: 'sat: {}',
      docs: 'https://x',
    })
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
    for (const bad of ['../../../etc', '..\\evil', 'a\\..\\b', '/abs', '', 'C:\\win']) {
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

  function fakeCodemods() {
    const stubCalls: Array<{ stubsRoot: string; stubPath: string }> = []
    return {
      stubCalls,
      async makeUsingStub(stubsRoot: string, stubPath: string) {
        stubCalls.push({ stubsRoot, stubPath })
      },
      async updateRcFile() {},
    }
  }

  test('publishes every stub when the host has none, idempotent on re-run', async ({ assert }) => {
    const found = await discoverSatellites(host.root)
    const sat = found.find((s) => s.packageName === '@fake/sat')!

    const codemods = fakeCodemods()
    const first = await publishSatellite(codemods, sat, [])
    assert.deepEqual(first.published.sort(), ['create_fake_one_table', 'create_fake_two_table'])
    assert.lengthOf(first.skipped, 0)
    assert.lengthOf(codemods.stubCalls, 2)
    assert.equal(codemods.stubCalls[0].stubsRoot, sat.root)
    assert.match(codemods.stubCalls[0].stubPath, /^stubs[\\/]migrations[\\/]create_fake_/)

    const existing = ['1700000000000_create_fake_one_table.ts']
    const codemods2 = fakeCodemods()
    const second = await publishSatellite(codemods2, sat, existing)
    assert.deepEqual(second.published, ['create_fake_two_table'])
    assert.deepEqual(second.skipped, ['create_fake_one_table'])
    assert.lengthOf(codemods2.stubCalls, 1)
  })

  test('a satellite with no migrations publishes nothing', async ({ assert }) => {
    const found = await discoverSatellites(host.root)
    const devsat = found.find((s) => s.packageName === '@fake/devsat')!
    const codemods = fakeCodemods()
    const result = await publishSatellite(codemods, devsat, [])
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

    const codemods = fakeCodemods()
    const result = await publishSatellite(codemods, sat, [])
    assert.deepEqual(result.published.sort(), ['create_fake_one_table', 'create_fake_two_table'])
    assert.lengthOf(codemods.stubCalls, 2)
  })

  test('returns empty when the migrations dir does not exist (no throw)', async ({ assert }) => {
    const sat: DiscoveredSatellite = {
      packageName: '@fake/missing',
      root: host.root,
      manifest: { name: 'missing', migrations: 'stubs/migrations' },
    }
    const codemods = fakeCodemods()
    const result = await publishSatellite(codemods, sat, [])
    assert.deepEqual(result, { published: [], skipped: [] })
    assert.lengthOf(codemods.stubCalls, 0)
  })

  test('throws when the migrations dir escapes the package root', async ({ assert }) => {
    const sat: DiscoveredSatellite = {
      packageName: '@evil/pkg',
      root: host.root,
      manifest: { name: 'evil', migrations: '../escape' },
    }
    await assert.rejects(async () => {
      await publishSatellite(fakeCodemods(), sat, [])
    }, /escapes the package root/)
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

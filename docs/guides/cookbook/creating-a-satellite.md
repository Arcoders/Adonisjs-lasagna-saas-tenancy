---
title: Creating a satellite
description: Build and publish your own packaged Lasagna satellite (provider, migrations, configure hook, and in-memory tests) without a PR to core.
---

# Creating a satellite

A **satellite** is an opt-in feature that attaches to tenants: audit logs,
feature flags, billing, and so on. The official ones ship as their own packages
(`@adonisjs-lasagna/billing`, `@adonisjs-lasagna/sso`). You can publish your own
the same way, and have it discovered, configured, and tested without a change to
the core package.

There is a runnable reference in the monorepo at
[`packages/satellite-template`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/packages/satellite-template).
Copy it as your starting point.

The `@adonisjs-lasagna/satellite-template` package is intentionally not published; it exists
so the public satellite contract is compiled and tested against a fresh consumer in CI. Use
it as a copy-target, and mirror the three concrete surfaces it exposes through its `exports`
map:

- the root export ships the feature itself: `ExampleWidgetService`, the `ExampleWidget`
  model, the `InMemoryWidgetStore` test double, and the `Widget` / `WidgetStore` types.
- `./provider` ships the provider as its default export, authored with the `definePlugin`
  facade (`export default definePlugin({ ... })`). The facade produces a
  `SatelliteProviderContract` and self-registers the satellite against core's registries;
  you declare what the satellite adds instead of hand-writing the lifecycle class.
- `./commands` ships the ace command entry points `getMetaData()` and `getCommand()`, plus
  the `example:widget:list` command (a teaching example, not an operator command).

The `lasagnaSatellite` manifest in its `package.json` wires `provider` and `commands` to
those subpaths; your own satellite declares the same keys.

## The one rule

A satellite depends on core. Core never depends on a satellite.

That keeps the dependency graph acyclic and lets satellites ship and version on
their own cadence. Your provider self-registers against core's public registries
(`HookRegistry`, `DoctorService`, `IsolationDriverRegistry`, the `@adonisjs/queue`
`Locator`, the emitter) instead of being wired in by core.

## Package layout

```
my-satellite/
  package.json            # declares the "lasagnaSatellite" manifest
  configure.ts            # the configure hook (node ace configure my-satellite)
  providers/
    my_provider.ts        # registers services + lifecycle hooks
  stubs/
    migrations/
      create_my_table.stub
  src/
    index.ts
    my_service.ts
    commands/             # optional ace commands
    testing/
      in_memory_my_store.ts
```

## The manifest

Declare a `lasagnaSatellite` key in your `package.json`. It is read as plain
JSON at configure time, so your package is never imported or executed during
discovery.

```jsonc
{
  "name": "@me/my-satellite",
  "files": ["build", "stubs"],
  "adonisjs": {
    "configure": "./build/configure.js",
    "commands": ["./build/src/commands/main.js"]
  },
  "lasagnaSatellite": {
    "name": "my-feature",                 // label shown in --list-satellites
    "satelliteApi": 1,                    // the Satellite ABI you built against (see below)
    "aliases": ["my-feature"],            // optional short names for --with=
    "migrations": "stubs/migrations",     // dir of .stub files, relative to the package root
    "requires": ["quotas"],               // optional core bundles to publish first
    "dependsOn": ["@me/other-satellite"], // optional other satellite PACKAGES (see below)
    "provider": "@me/my-satellite/provider",  // optional: added to adonisrc.ts
    "commands": "@me/my-satellite/commands",   // optional: added to adonisrc.ts
    "env": ["MY_API_KEY"],                // optional: printed as a reminder
    "install": ["npm install @me/my-satellite"],
    "configSnippet": "myFeature: { /* ... */ }",  // optional: printed for the host to paste
    "docs": "https://example.com/docs/my-satellite"
  }
}
```

Only `name` is required. A satellite with no `migrations` is a config-only
feature; one with no `provider` ships no AdonisJS provider.

`migrations` must be a path inside your package. Absolute paths and `..`
segments are rejected; the same rule now applies to `provider` and `commands`,
since they are written into the host's `adonisrc.ts` and imported on every boot.

`requires` names core feature **bundles** (published from core, e.g. `quotas`).
`dependsOn` names other satellite **packages** you need installed and configured
first. `configure` pulls each into the selection, orders dependencies before
dependents (so their provider boots first), and refuses to proceed on a missing
dependency or a cycle. Use the object form to pin a version:
`"dependsOn": [{ "pkg": "@me/other", "range": "^1.0.0" }]` (the range is checked
best-effort and reported as a warning).

`configure` writes the satellite providers into `adonisrc.ts` in this dependency-first
order. Do not hand-reorder that block: AdonisJS boots providers in file order, so moving a
dependent above the dependency it relies on can start it before that dependency has booted.

## Declare the Satellite ABI you target

`satelliteApi` is the version of the extension surface your satellite builds
against: the core registries you self-register into (`HookRegistry`,
`DoctorService`, `IsolationDriverRegistry`, the queue `Locator`, the emitter),
the manifest shape, and the configure contract. Core exports the current value
as `SATELLITE_API_VERSION` (from `@adonisjs-lasagna/saas-tenancy/sdk`); it is a
single monotonic integer, bumped only on a backward-incompatible change to that
surface, and versioned independently of core's published version.

`configure` compares your declared `satelliteApi` against the installed core:

- you need a **newer** ABI than the core provides: `configure` refuses to wire
  the satellite and exits non-zero (upgrade the core),
- you built against an **older** ABI: it warns but proceeds,
- you **omit** it: it warns that compatibility is unverified.

Set it to the value of `SATELLITE_API_VERSION` you developed against (today, `1`).
The `definePlugin` facade asserts it at runtime for you from the `satelliteApi`
field; a hand-written provider calls `assertSatelliteApiCompatAtBoot(...)` from
`/sdk` itself in `boot()`.

## The provider

Author the provider with the [`definePlugin` facade](/guides/plugins): declare what
the satellite adds and the facade wires the ABI backstops and the request-path
seams for you. This is the shape the reference template ships.

```ts
// providers/my_provider.ts
import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'
import { HookRegistry } from '@adonisjs-lasagna/saas-tenancy/services'
import MyService from '../src/my_service.js'

export default definePlugin({
  name: 'my-feature',
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  bind(app) {
    app.container.singleton(MyService, () => new MyService())
  },

  async start(app) {
    const hooks = await app.container.make(HookRegistry)
    hooks.before('destroy', async (ctx) => {
      const service = await app.container.make(MyService)
      await service.deleteForTenant(ctx.tenant.id)
    })
  },
})
```

Every hook (`bind`, `boot`, `start`, `ready`, `shutdown`) is optional. Resolve core
services with `app.container.make(...)`; never `new` a core service yourself. The
facade runs the `satelliteApi` boot-time assert for you (the ABI declared above),
so a satellite gets the runtime compatibility backstop with no boilerplate.

Reach for a raw `implements SatelliteProviderContract` class only when you need
lifecycle control the spec does not model. See
[Building a plugin](/guides/plugins) for the full facade reference, including the
authorizer, middleware, request-macro, and capability seams.

## Migrations

Ship migrations as `.stub` files under the directory your manifest's
`migrations` points at. Every satellite table lives in the shared `backoffice`
schema, scoped by `tenant_id`, so cross-tenant reporting stays a single query.

Because every satellite shares the `backoffice` schema, **name your table for
your package** (e.g. `crm_contacts`, not `contacts`) so it can't collide with
another satellite's table. `configure` namespaces the published migration *file*
by package automatically (`<ts>_<your_pkg>__<stub>.ts`), so two satellites that
happen to ship the same stub basename both install correctly, but the table
name inside the migration is yours to keep unique.

```
// stubs/migrations/create_my_table.stub
{{{
  exports({ to: app.migrationsPath(`${Date.now()}_create_my_table.ts`) })
}}}
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'my_table'

  async up() {
    this.schema.withSchema('backoffice').createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.db.rawQuery('gen_random_uuid()').knexQuery)
      table.uuid('tenant_id').notNullable().index()
      // ...
    })
  }

  async down() {
    this.schema.withSchema('backoffice').dropTable(this.tableName)
  }
}
```

The `${Date.now()}` prefix in the `exports` header is what makes publishing
idempotent: the configure command skips a stub whose table is already present in
the host's migrations directory, so re-running it never writes a duplicate.

## The configure hook

Your hook reads your own manifest and hands it to the shared toolkit. This is
the same code core runs for `--with=`, so the two install paths behave
identically.

```ts
// configure.ts
import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile } from 'node:fs/promises'
import {
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  readSatelliteManifest,
} from '@adonisjs-lasagna/saas-tenancy/sdk'

export default async function configure(command: Configure) {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
  const pkgJson = JSON.parse(await readFile(join(pkgRoot, 'package.json'), 'utf8'))
  const manifest = readSatelliteManifest(pkgJson, (m) => command.logger.warning(m))
  if (!manifest) return

  const app = command.app as unknown as {
    migrationsPath?: (...p: string[]) => string
    makePath: (...p: string[]) => string
  }
  const migrationsDir =
    typeof app.migrationsPath === 'function'
      ? app.migrationsPath()
      : app.makePath('database', 'migrations')

  const codemods = await command.createCodemods()
  // Publishes this package's migrations into the host's migrations dir,
  // idempotently, namespacing each file by package so it can't collide with
  // another satellite that ships the same stub basename.
  await publishSatellite(
    codemods,
    { packageName: pkgJson.name, root: pkgRoot, manifest },
    migrationsDir
  )
  await registerSatelliteInRcFile(codemods, manifest)
  printSatelliteManifest(command.logger, manifest)
}
```

## Two ways a host installs it

Both run the same toolkit, so they end up in the same place.

```bash
# 1. Your package's own configure hook
node ace configure @me/my-satellite

# 2. Through core, alongside the built-in satellites
node ace configure @adonisjs-lasagna/saas-tenancy --with=@me/my-satellite
```

A host can see what is installed with:

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --list-satellites
```

### `requires` and core prerequisites

If your satellite needs a core bundle (for example, billing needs `quotas` for
the `tenant_plans` table), list it in `requires`. The core `--with=` path
auto-publishes those core bundles first. Your own hook cannot publish a core
stub, so it prints the prerequisite for the operator to run:

```bash
node ace configure @adonisjs-lasagna/saas-tenancy --with=quotas
```

## Testing with an in-memory double

Define your service as an interface, then provide two implementations: the real
one (backed by your Lucid model) and an in-memory one for hermetic tests. The
in-memory store needs nothing more than a small id-keyed `Map`. The template
ships a tiny, copyable `InMemoryStore` helper at `src/testing/in_memory_store.ts`;
copy it into your package (it has zero dependencies).

```ts
// src/testing/in_memory_my_store.ts
import InMemoryStore from './in_memory_store.js' // the copyable helper from the template
import type { MyRow, MyStore } from '../types.js'

export default class InMemoryMyStore implements MyStore {
  readonly #store = new InMemoryStore<MyRow>()

  async create(input: { tenantId: string; name: string }): Promise<MyRow> {
    return this.#store.insert({ id: this.#store.seq('r_'), ...input, enabled: true })
  }
  async listForTenant(tenantId: string): Promise<MyRow[]> {
    return this.#store.filter((r) => r.tenantId === tenantId)
  }
  // ...
}
```

Tests then run with no database:

```ts
import { test } from '@japa/runner'
import InMemoryMyStore from '../../src/testing/in_memory_my_store.js'

test('lists only the tenant rows', async ({ assert }) => {
  const store = new InMemoryMyStore()
  await store.create({ tenantId: 't1', name: 'a' })
  await store.create({ tenantId: 't2', name: 'b' })
  assert.lengthOf(await store.listForTenant('t1'), 1)
})
```

This is the same pattern the billing satellite uses with its `MockBillingDriver`:
a second implementation of the contract proves the abstraction is real and lets
consumers test against it without a live dependency.

## Publishing

Set `"files": ["build", "stubs"]` so the stubs ship in the tarball, build, and
publish:

```bash
npm run build
npm publish --access public
```

Peer-depend on the core package so a host resolves one shared copy:

```jsonc
"peerDependencies": {
  "@adonisjs-lasagna/saas-tenancy": "^1.0.0",
  "@adonisjs/core": "^7.0.0",
  "@adonisjs/lucid": "^22.0.0"
}
```

## Stability of the contract

The `@adonisjs-lasagna/saas-tenancy/sdk` surface (the `SatelliteManifest`,
`SatelliteProviderContract`, and the configure toolkit) is a supported public
extension point under the 1.x semver promise. See [Stability](/reference/stability).

## Read next

- [Satellites](/guides/satellites/); the built-in feature set you are extending.
- [Hooks](/reference/hooks); the tenant-lifecycle phases your provider can attach to.
- [Custom isolation driver](/guides/cookbook/custom-isolation-driver); the other
  public extension seam.

---
title: Building a plugin
description: definePlugin is one declarative facade for a Lasagna satellite — lifecycle hooks plus the authorizer, middleware, request-macro, and capability seams, with the ABI ceremony wired for you.
---

# Building a plugin

`definePlugin` is the blessed way to author a Lasagna satellite. You pass one
declarative spec and get back a provider class, so a satellite's provider
collapses to a single `export default definePlugin({ ... })`. The facade wires the
version-compatibility backstops for you and exposes the request-path extension
seams (authorizers, middleware, request macros, capabilities) as typed fields, so
you declare *what* your plugin adds and the facade handles *how* it attaches.

This page is the facade reference. For end-to-end packaging (the manifest, the
configure hook, migrations, publishing) see [Creating a satellite](/guides/cookbook/creating-a-satellite);
for the shared version-compatibility rules every extension follows see
[Extensibility](/guides/extensibility).

<Callout type="tip" title="definePlugin is sugar over the raw contract">
Everything here compiles down to a class that implements
`SatelliteProviderContract`. You can still hand-write that class when you need
full control of the lifecycle; the facade just removes the boilerplate that every
provider repeats.
</Callout>

## The minimal plugin

```ts
// providers/my_plugin.ts
import { definePlugin, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'

export default definePlugin({
  name: 'my-feature',
  // The Satellite ABI you built against (mirrors package.json#lasagnaSatellite.satelliteApi).
  satelliteApi: 1,
  // The definePlugin facade contract you built against (independent of satelliteApi).
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,
})
```

Registered in the host's `adonisrc.ts` like any provider (the configure hook does
this for you), this does nothing yet except assert compatibility at boot. The
`name` is a short registration slug validated as a safe identifier at
`definePlugin()` call time, so a bad name fails at import, not deep in boot.

## What the facade gives you

- **The ABI ceremony, once.** At `boot()` the facade runs
  `assertSatelliteApiCompatAtBoot` (is this satellite compatible with this
  **core**?) and `assertPluginApiCompatAtBoot` (is it compatible with this
  **facade**?). A core too old throws and aborts the deploy; an older or
  undeclared version warns. This is the runtime backstop for a core downgrade that
  slips past install-time `configure`.
- **A closed-union dispatcher.** Each declarative section yields entries
  discriminated by a `kind`, and the facade's boot dispatcher `switch`es over them
  exhaustively. Adding a seam the dispatcher does not handle is a compile error, so
  a section can never silently no-op.
- **Fail-closed boot.** Any section factory or lifecycle hook that throws is
  wrapped in a `PluginBootException` attributed to `{ plugin, phase }`. A
  half-wired plugin aborts the deploy instead of running degraded.

## Lifecycle hooks

Every spec field except `name` / `satelliteApi` is optional. The five lifecycle
hooks map onto the AdonisJS provider phases:

| Hook | Provider phase | Use it for |
|---|---|---|
| `bind` | `register()` | Bind your own singletons into the container. |
| `boot` | `boot()` (after the ABI asserts + section wiring) | Validate config, read the container. |
| `start` | `start()` | Self-register tenant-lifecycle hooks against core registries. |
| `ready` | `ready()` | Wire event listeners (the emitter is guaranteed to exist here). |
| `shutdown` | `shutdown()` | Release resources on graceful shutdown. |

```ts
// providers/my_plugin.ts
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
    // Clean up this satellite's rows when a tenant is hard-deleted.
    hooks.before('destroy', async (ctx) => {
      const service = await app.container.make(MyService)
      await service.deleteForTenant(ctx.tenant.id)
    })
  },
})
```

Resolve core services with `app.container.make(...)`; never `new` a core service
yourself. The dependency only ever goes satellite → core.

<Callout type="warning" title="Wire event listeners in `ready`, not `boot`">
The emitter resolves through `app.booted()`, so subscribing in `boot()` can race
that and silently drop the subscription. Subscribe in `ready`, which runs after
`boot`. The reporting satellite wires its cache invalidation exactly this way.
</Callout>

## Sections are functions

Every declarative section (`authorizers`, `middleware`, `requestMacros`,
`provides`) is a function of the app, never a bare value:

```ts
export type PluginSection<T> = (app: ApplicationService) => T | Promise<T>
```

That keeps a plugin module importable without a booted app: the section body only
runs when the facade calls it at `boot()`, so it can read config or resolve a
dependency lazily. Do not do that work at module top level.

## The version numbers

A plugin author juggles three independent version integers. They never alias each
other, and each answers a different question:

| Version | Declared as | Answers |
|---|---|---|
| `satelliteApi` | `definePlugin({ satelliteApi })` | Does this satellite fit this **core**? |
| `pluginApiVersion` | `definePlugin({ pluginApiVersion })` | Does it fit this **facade**? |
| `contractVersion` | on each authorizer / middleware / capability entry | Does this extension fit that **surface**? |

All three use the same asymmetric rule (newer than provided fails, older or absent
warns, equal is ok). Set each to the constant the SDK exports
(`LASAGNA_PLUGIN_API_VERSION`, `AUTHORIZER_CONTRACT_VERSION`, and so on) so an
equal match clears the warning. See [Extensibility](/guides/extensibility) for the
full model.

## Request-path seams

These are the four sections that attach code to the request path. A plugin uses
only the ones it needs.

Each seam has a typed **builder** — `authorizer()`, `middleware()`, `requestMacro()`,
`defineCapability()` — and it is the recommended way to author an entry. The builder
mints the branded name (rejecting an unsafe one at authoring time), stamps the `kind`
discriminant, and defaults `contractVersion` to the SDK's current constant, so you
write the fields that matter and nothing else. The raw discriminated object still
works when you want full control.

### Authorizers (fail-closed)

An authorizer appends to the tenant-access decision chain. It runs on every
tenant-scoped request after the tenant resolves, and it is **fail-closed**: any
`{ allow: false }`, thrown error, or deadline overrun denies with an opaque 403.

```ts
// providers/seat_limit_plugin.ts
import {
  definePlugin,
  authorizer,
  LASAGNA_PLUGIN_API_VERSION,
} from '@adonisjs-lasagna/saas-tenancy/plugin'
import { withinSeatLimit } from '../src/seats.js'

export default definePlugin({
  name: 'seat-limit',
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,

  authorizers: () => [
    authorizer({
      name: 'seat_limit',
      order: 0, // ascending; ties break by registration order
      authorize: async (ctx, tenant) => {
        return (await withinSeatLimit(tenant))
          ? { allow: true }
          : { allow: false, reason: 'seat limit reached' }
      },
    }),
  ],
})
```

The `authorizer()` builder mints the branded `seat_limit` name and stamps the
current `AUTHORIZER_CONTRACT_VERSION` for you. `throw` is not part of the contract: the chain converts a thrown authorizer to a
deny internally, so an author's bug fails safe. A hung authorizer denies on a
deadline (default one second, tunable via `plugins.limits.authorizerDeadlineMs`);
it is a response deadline, not cancellation. Every fail-closed deny trips the
`guard.plugin_authorizer` [isthmus guard](/reference/isthmus) so it is never
invisible to an operator.

<Callout type="warning" title="A plugin authorizer is additive, not a substitute for the membership gate">
A registered authorizer tightens access; it does not satisfy the
`config.authorizeTenantAccess` membership-gate signal (the boot warning and the
doctor check stay bound to that config callback). So a plugin can never silently
mask a missing cross-tenant IDOR gate. Keep `authorizeTenantAccess` set.
</Callout>

### Middleware

A middleware entry is stacked onto one of the three route scopes, after the core
scope middleware (so `request.tenant()` is already resolved) and before the host's
own `.use()` chain.

```ts
  middleware: () => [
    middleware({
      name: 'request_id',
      scope: 'tenant', // 'tenant' (default) | 'central' | 'universal'
      middleware: async (ctx, next) => {
        ctx.response.header('x-request-id', ctx.request.id())
        return next()
      },
    }),
  ],
```

The `middleware()` builder comes from the same `/plugin` import. Its `middleware`
value is either a bare `(ctx, next)` function or an object with a `handle(ctx, next)`
method, matching the Adonis router's `.use()`.

### Request macros

A request macro adds a memoized `request.<name>()` accessor, mirroring the built-in
`request.tenant()`. It is computed once per request and cached under a private
symbol.

```ts
  requestMacros: () => [
    requestMacro({
      name: 'locale',
      requireTenant: true, // fail closed if no tenant resolves
      resolve: (request) => request.header('accept-language') ?? 'en',
    }),
  ],
```

The name is collision-checked against `tenant()`, other plugins' macros, and
existing request properties; a clash throws a `RequestMacroCollisionException` at
boot. To call it type-safely (`request.locale()`), augment the Adonis `Request`
interface in your own declaration file.

### Capabilities (provide / consume)

Capabilities are optional, degradable cross-plugin composition: one plugin
**provides** a keyed api, another **consumes** it if installed. Use it for "use it
if present" wiring; keep direct-import + `dependsOn` for hard dependencies.

```ts
  provides: () => [
    defineCapability({
      name: 'email',
      api: { send: async (msg: EmailMessage) => { /* ... */ } },
    }),
  ],
```

`defineCapability({ name: 'email', api })` type-checks `api` against your augmented
`email` capability when you augment `LasagnaCapabilities` (below).
Providing is single-writer: two plugins providing the same key is a deploy-time
`CapabilityCollisionException`, never last-writer-wins. A consumer resolves the
registry and reads the key, degrading gracefully when it is absent:

```ts
// somewhere in a consumer's boot() or a service
import { CapabilityRegistry } from '@adonisjs-lasagna/saas-tenancy/services'

const caps = await app.container.make(CapabilityRegistry)
const email = caps.consume('email') // typed via LasagnaCapabilities; undefined if not installed
if (email) await email.send(message)
```

To type `consume('email')` as your api instead of `unknown`, augment the open
`LasagnaCapabilities` interface from your plugin:

```ts
// src/capabilities.ts
import type { EmailApi } from './email.js'

declare module '@adonisjs-lasagna/saas-tenancy/plugin' {
  interface LasagnaCapabilities {
    email: EmailApi
  }
}
```

A compilation that never imports your plugin sees no `email` key, so the type only
appears where the capability actually can.

### Sensitive capabilities and the trust allowlist

A capability that hands out privileged reach (raw tenant data, key material) marks
itself `sensitive`:

```ts
defineCapability({ name: 'secret_keys', api, sensitive: true })
```

A sensitive capability crosses a trust gate. Only a plugin on the operator's
`TRUSTED_SATELLITES` allowlist (a comma- or space-separated list of plugin names in
the environment) may **provide** one, and only trusted code may **consume** one — an
untrusted attempt throws `CapabilityTrustException` (403) rather than degrading to
`undefined`. Ordinary (non-sensitive) capabilities ignore the allowlist and stay
freely composable. The bump to `CAPABILITY_CONTRACT_VERSION` 2 records this: a plugin
built for v1 still boots (its provisions are unversioned or older, so the registry
warns rather than fails).

<Callout type="warning" title="The trust allowlist is friction, not a sandbox">
`TRUSTED_SATELLITES` also gates the in-process core-access funnels: an untrusted
plugin that resolves the host tenant repository or the shared db handle through the
sanctioned accessors is denied. This raises the cost of a careless reach, but an
installed plugin runs with full in-process privilege — a direct `import` of the db
service evades the db funnel. The wall that actually denies an untrusted write is the
read-only Postgres role (below), enforced by the database, not by JavaScript.
</Callout>

## Limits and the authorizer deadline

The request-path surfaces are cappable. A host sets `plugins.limits` to bound how
many authorizers, middleware, and capabilities the installed plugins may register,
and to tune the authorizer deadline:

```ts
// config/multitenancy.ts
plugins: {
  limits: {
    maxAuthorizers: 16,
    maxMiddleware: 16,
    maxCapabilities: 64,
    authorizerDeadlineMs: 1000,
  },
}
```

The `max*` caps are fail-closed and checked once at boot, after every plugin has
registered: a surface over its cap aborts the deploy with a `PluginBootException`,
so a runaway or hostile plugin can't quietly bloat the per-request chain. Every cap
is optional and defaults to unlimited, so a host that omits the block is
unaffected. See the [configuration reference](/reference/configuration#plugin-platform)
for the full table.

## Declaring permissions

A plugin declares the sensitive capabilities it needs so the operator consents to
them at install. Populate `permissions` through the `permission.*` builders:

```ts
import { definePlugin, permission, LASAGNA_PLUGIN_API_VERSION } from '@adonisjs-lasagna/saas-tenancy/plugin'

export default definePlugin({
  name: 'search',
  satelliteApi: 1,
  pluginApiVersion: LASAGNA_PLUGIN_API_VERSION,
  permissions: [
    permission.dataChange('User', 'Order'), // reindex on writes to these models
    permission.networkExternal(),           // ship documents to a search cluster
  ],
})
```

The same set must appear in the package manifest, in canonical wire form, so
`configure` can read it without importing the plugin:

```json
// package.json
"lasagnaSatellite": {
  "name": "search",
  "permissions": ["data_change:User,Order", "network:external"]
}
```

The `check-plugin-permissions` gate fails the build if the two drift, so the set
the operator consents to always matches the code.

At install, `configure` shows the requested capabilities and asks for consent.
Consent is fail-closed: on a non-interactive install (CI, a piped command) the
satellite is SKIPPED unless you pass `--accept-permissions` (or set
`LASAGNA_ACCEPT_PERMISSIONS=1`), so a scripted install can never silently accept a
plugin's sensitive capabilities.

| Builder | Wire form | Capability |
|---|---|---|
| `permission.scheduler()` | `scheduler` | Registers background scheduled jobs. |
| `permission.dataChange(...models)` | `data_change:User,Order` | Observes writes on the named models. |
| `permission.networkExternal()` | `network:external` | Outbound calls to hosts outside the cluster. |
| `permission.dbWrite()` | `db:write` | Writes to the tenant database (only effective for a trusted plugin). |

<Callout type="warning" title="Declaration is disclosure, not a sandbox">
Declaring `db:write` does not grant a write, and declaring nothing does not block
one. Permissions make the install honest so the operator sees what a plugin
intends to do. The real containment is enforced elsewhere: an untrusted plugin is
routed to a read-only database connection regardless of what it declares, and
outbound traffic is bounded by the worker network policy.
</Callout>

## Schedules

A plugin can register a periodic **tick** that fans out over active tenants. Each
tick dispatches a per-tenant job to every tenant matching a status filter, so a
"reindex nightly" or "sync every 5 minutes" feature is one declarative entry
rather than N per-tenant repeatables you have to tear down on suspend/delete.

```ts
import { definePlugin, schedule } from '@adonisjs-lasagna/saas-tenancy/plugin'

export default definePlugin({
  name: 'search',
  satelliteApi: 1,
  permissions: [permission.scheduler()], // consent-gated at install (S1)
  schedules: () => [
    schedule({ name: 'reindex', job: 'search.ReindexTenant', everyMs: 300_000 }),
    schedule({ name: 'digest', job: 'app.SendDigest', cron: '0 2 * * *', jitterMs: 30_000 }),
  ],
})
```

Set exactly one of `cron` or `everyMs`. `job` is the per-tenant job name dispatched
to each active tenant's queue. The tick runs on the host's `queue:work` worker, so
the `schedules` seam needs `@adonisjs/queue` configured; declare
`permission.scheduler()` so the operator consents to it at install (disclosure, not
enforcement). The full model — the native scheduler backend, the status filter,
reconciling vs fire-once delivery, and idempotency — is in
[Scheduler](/guides/scheduler).

## Provisioning Postgres extensions

A plugin whose tables need a Postgres extension (pgvector, PostGIS, `pg_trgm`)
declares it with `provisionExtensions`. The facade registers an `after('provision')`
hook that installs each extension into every newly-provisioned tenant's storage —
per tenant database on `database-pg`, once on the shared database for
`schema-pg`/`rowscope-pg` — under the privileged provisioning connection
(`isolation.provisionConnectionName`), so the app's least-privilege request role
never runs `CREATE EXTENSION`.

```ts
export default definePlugin({
  name: 'search',
  satelliteApi: 1,
  provisionExtensions: () => [{ name: 'pg_trgm' }, { name: 'vector', schema: 'extensions' }],
})
```

The extension name and optional schema are validated as safe DDL identifiers at
boot, so a typo fails the deploy rather than the first tenant provision. Installing
into an extension's own `schema` (as pgvector does) keeps `public` off the tenant
search path. Need to backfill existing tenants, or run it by hand? Call the exported
`provisionExtension({ name, schema })` from `@adonisjs-lasagna/saas-tenancy/services`
directly.

## Reacting to writes

A plugin reacts to committed tenant-model writes with `onDataChange`. A model opts
in with the `TracksDataChanges` mixin (from `@adonisjs-lasagna/saas-tenancy/mixins`);
each committed write then emits an after-commit, PII-free `TenantDataChanged`, and
the plugin subscribes with model/operation filters:

```ts
export default definePlugin({
  name: 'search',
  satelliteApi: 1,
  onDataChange: () => [
    { models: ['Order'], operations: ['create', 'update'], handle: async (c) => reindex(c) },
  ],
})
```

Handlers run decoupled from the write (after-commit, fail-open), so a slow or failing
subscriber never blocks or rolls back the write. It fires for instance writes
(`save`/`create`/`delete`) only — a query-builder bulk `update`/`delete` emits
nothing. The full model — the mixin, the names-only payload, the bulk-write and
minification caveats, the re-read pattern for values — is in
[Data-change hooks](/guides/data-change-hooks).

## The `/plugin` import surface

One import path carries everything a plugin author needs:

| Export | Kind | For |
|---|---|---|
| `definePlugin` | function | Build the provider from a spec. |
| `PluginSpec`, `PluginSection` | types | The spec shape and its section signature. |
| `authorizer`, `middleware`, `requestMacro`, `defineCapability`, `schedule` | functions | Typed section builders (the recommended way to author an entry). |
| `permission` | object | The permission builders (`permission.scheduler()`, `.dataChange(...)`, `.networkExternal()`, `.dbWrite()`). |
| `PluginPermission`, `ModelName`, `modelName` | types + function | The permission union and the model-name brand. |
| `LASAGNA_PLUGIN_API_VERSION` | const | The facade contract version to declare. |
| `pluginName`, `authorizerName`, `middlewareName`, `macroName`, `capabilityKey` | functions | Mint a branded, identifier-safe name (the builders call these for you). |
| `AUTHORIZER_CONTRACT_VERSION`, `TenantAuthorizerEntry`, `AuthorizerDecision` | const + types | The authorizer seam. |
| `TENANT_MIDDLEWARE_CONTRACT_VERSION`, `TenantMiddlewareEntry`, `TenantMiddlewareScope` | const + types | The middleware seam. |
| `TenantRequestMacroSpec` | type | The request-macro seam. |
| `CAPABILITY_CONTRACT_VERSION`, `CapabilityProvision`, `LasagnaCapabilities` | const + types | The capability seam. |
| `TenantSchedule`, `scheduleName`, `ScheduleName` | type + function + type | The scheduler seam (see [Scheduler](/guides/scheduler)). |
| `ProvisionExtensionSpec` | type | The extension-provisioning seam (SEAM-7). |
| `TenantDataChangeSubscription`, `TenantDataChangePayload`, `TenantDataChangeOperation` | types | The data-change seam ([Data-change hooks](/guides/data-change-hooks)). The `TracksDataChanges` mixin lives at `/mixins`. |

The barrel is app.booted-safe: importing it never drags in a service that needs a
booted app, so a plugin module loads under any tooling.

## When to hand-write the contract instead

Reach for a raw `implements SatelliteProviderContract` class when you need
behavior the spec does not model: conditional wiring across phases that a single
section can't express, or a provider that other core machinery constructs
directly. `definePlugin` compiles down to exactly that contract, so nothing is
out of reach.

Every satellite we ship uses `definePlugin`, including billing, SSO, backup,
reporting, and AI, and so does the
[satellite reference template](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/tree/master/packages/satellite-template).
The raw contract stays supported and covered by its own back-compat spec, but the
facade is the path we build on ourselves.

## Read next

- [Creating a satellite](/guides/cookbook/creating-a-satellite); the full package
  around this provider (manifest, configure hook, migrations, publishing).
- [Extensibility](/guides/extensibility); the version-compatibility standard every
  extension surface shares.
- [Scheduler](/guides/scheduler); the full model behind the `schedules` seam.
- [Isthmus guard registry](/reference/isthmus); where the fail-closed authorizer
  deny is counted.
- [Hooks](/reference/hooks); the tenant-lifecycle phases a `start` hook attaches to.

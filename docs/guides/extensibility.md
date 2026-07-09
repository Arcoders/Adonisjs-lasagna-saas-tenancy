# Extensibility standard

Most Lasagna surfaces let you plug in your own code: a custom report, a payment
driver, an audit sink, a feature-flag strategy. This page is the one contract
they all follow, so once you have written one extension you know how to write
any of them.

If you are packaging a whole satellite, the [`definePlugin` facade](/guides/plugins)
wires several of these seams (tenant-access authorizers, route middleware, request
macros, capabilities) into one declarative spec. This page is the contract those
seams sit on.

## The two version numbers

Lasagna has two independent version integers. Keep them straight:

| | `satelliteApi` | `contractVersion` |
|---|---|---|
| Lives in | `package.json#lasagnaSatellite.satelliteApi` | each extension you register |
| Answers | "does this satellite fit this **core**?" | "does this extension fit this **surface**?" |
| Checked by | `configure` / provider boot | the surface's registry, at `register()` |
| Helper | `checkSatelliteApiCompat` | `checkContractCompat` / `assertContractCompat` |

Both are independent of the package's published (npm) version, and both use the
same asymmetric rule. For the full index of every version integer in the fleet and
its current value, see [Contract versions](/reference/contract-versions).

## The compatibility rule

An extension declares the `contractVersion` it was built against. When you
register it, the surface compares that to its own `CONTRACT_VERSION`:

- **newer** than the surface provides — `fail` (throws). The extension relies on
  contract this build does not have. Upgrade the satellite, or pin the extension.
- **older** than the surface — `warn`. The surface may have changed under it; it
  still registers and runs, degraded. Check the changelog.
- **equal** — `ok`.
- **absent** — `warn` (unversioned). It registers, but declare a version to opt
  into the check.

This is exactly the Satellite ABI rule, one level down, so there is only one
mental model to learn. Validation happens at the point of registration (a host
registers extensions in its own provider `boot()`, which can run after the
satellite's), and the offending extension is named in the error.

## Execution guards

Surfaces that run host code on a request path (reporting, admin) accept two
optional guards, both off by default:

- **`timeoutMs` is a response deadline, not a kill switch.** A timed-out
  extension keeps running; the deadline only frees the caller. The surface fires
  the `AbortSignal` it passes your `execute`, so cooperative code can unwind. A
  report that ignores the signal keeps holding its connection, so mind the
  connection budget.
- **`rateLimit`** is a Redis-backed sliding window. It follows the global
  `resilience.redis.rateLimit` fail policy (fail-closed by default) on an outage.

## Trust model

Extensions run **in-process with full trust**. There is no sandbox: a report
that reads another tenant's schema, or a transformer that mutates a payload, is
doing exactly what its code says. `timeoutMs` bounds latency, not capability, and
there is intentionally no memory limit (it is not enforceable for an in-process
async function). Treat registering an extension like adding code to your app,
because that is what it is.

## The surfaces

| Surface | Extension point | Registry | Version constant |
|---|---|---|---|
| [reporting](/guides/satellites/reporting) | custom reports | `ReportExtensionRegistry` | `REPORTING_CONTRACT_VERSION` |
| [billing](/guides/satellites/billing) | payment drivers | `BillingDriverRegistry` | `BILLING_CONTRACT_VERSION` |
| [websockets](/guides/satellites/websockets) | authorize hook | config `authorize` | `WEBSOCKETS_CONTRACT_VERSION` |
| [admin](/guides/satellites/admin) | custom actions | `adminActionRegistry` | `ADMIN_CONTRACT_VERSION` |
| [sso](/guides/satellites/sso) | identity providers | `identityProviderRegistry` | `SSO_CONTRACT_VERSION` |
| [audit](/guides/satellites/audit) | log destinations | `AuditLogDestinationRegistry` | `AUDIT_CONTRACT_VERSION` |
| [feature-flags](/guides/satellites/feature-flags) | evaluation strategies | `EvaluationStrategyRegistry` | `FEATURE_FLAGS_CONTRACT_VERSION` |
| [webhooks](/guides/satellites/webhooks) | payload transformers | `WebhookTransformerRegistry` | `WEBHOOKS_CONTRACT_VERSION` |
| [isolation](/guides/cookbook/custom-isolation-driver) | custom isolation drivers | `IsolationDriverRegistry` | `ISOLATION_CONTRACT_VERSION` |
| resolution | custom tenant resolvers | `TenantResolverRegistry` | `RESOLVER_CONTRACT_VERSION` |
| [plugin](/guides/plugins) | tenant-access authorizers | `AuthorizerRegistry` | `AUTHORIZER_CONTRACT_VERSION` |
| [plugin](/guides/plugins) | route middleware | `TenantMiddlewareRegistry` | `TENANT_MIDDLEWARE_CONTRACT_VERSION` |
| [plugin](/guides/plugins) | cross-plugin capabilities | `CapabilityRegistry` | `CAPABILITY_CONTRACT_VERSION` |
| [ai](/guides/satellites/ai) | AI providers | `AIProviderRegistry` | `AI_CONTRACT_VERSION` |
| [crypto](/guides/satellites/crypto) | key providers | `KeyProviderRegistry` | `CRYPTO_CONTRACT_VERSION` |

`reporting`, `audit`, `feature-flags`, and `webhooks` registries are container
singletons (resolve via `container.make`). `admin` and `sso` ship only a minimal
backstop provider (it asserts the Satellite ABI and the plugin-API contract at
boot and binds nothing), so their registries stay module-level singletons you
import directly. `billing`
selects its active driver from `config.billing.driver`; `websockets` reads its
hook from config. The `isolation` and `resolution` registries live in core and
are also container singletons — a custom `IsolationDriver` or `TenantResolver`
declares `contractVersion: ISOLATION_CONTRACT_VERSION` / `RESOLVER_CONTRACT_VERSION`
and the registry refuses one built for a newer core (older/absent only warn).

## Writing an extension

The shape is the same everywhere: an object with a `name`, a `contractVersion`,
and the surface's one method. Reporting is the worked example:

```ts
import { REPORTING_CONTRACT_VERSION } from '@adonisjs-lasagna/reporting'
import type { ReportExtension } from '@adonisjs-lasagna/reporting'

class TopPropertiesReport implements ReportExtension {
  name = 'top_properties'
  description = 'Top 5 most-booked properties'
  contractVersion = REPORTING_CONTRACT_VERSION
  async execute(filters, _options, signal) {
    // your query here; thread `signal` into long work
    return { rows: [] }
  }
}

// in a provider boot()
const registry = await app.container.make(ReportExtensionRegistry)
registry.register(new TopPropertiesReport())
```

For a module-singleton surface (admin, sso) you import the registry instead of
resolving it:

```ts
import { adminActionRegistry, ADMIN_CONTRACT_VERSION } from '@adonisjs-lasagna/admin'

adminActionRegistry.register({
  name: 'reindex_search',
  description: 'Rebuild the tenant search index',
  contractVersion: ADMIN_CONTRACT_VERSION,
  execute: async (ctx) => ({ queued: true }),
})
```

Each satellite's own page documents its method signature and any surface-specific
rules (for example, webhook transformers run once before signing and must return
a plain object; audit destinations are best-effort and never block the DB write).

## Testing

Reporting ships pure test helpers under `@adonisjs-lasagna/reporting/testing`
(`createTestExtension`, `registryWith`). For any surface, the registry is pure
and unit-testable without a booted app: register an extension whose
`contractVersion` is `CONTRACT_VERSION + 1` to assert the failure path, or an
older one to assert it warns but registers.

## Migration policy

`CONTRACT_VERSION` is a major. It is bumped only on a backward-incompatible
change to a surface (a removed field, a changed method shape). Additive,
backward-compatible changes do not bump it. When a surface bumps:

1. Its `CHANGELOG.md` documents what changed and how to migrate.
2. Existing extensions on the previous version keep loading with a warning, so a
   deploy never hard-breaks on the bump alone.
3. Update your extension and set its `contractVersion` to the new value to clear
   the warning.

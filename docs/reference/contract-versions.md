---
title: Contract versions
description: The one index of every Lasagna version integer — the two fleet-wide axes (Satellite ABI, plugin API) and the per-surface extension contracts — with their current values, how each is asserted, and what a bump obligates.
---

# Contract versions

Lasagna versions its **contracts** with plain integers, independently of the npm
package version. A host, a satellite, and an extension can each be built against a
different revision of a surface, so every seam carries a version the other side
checks at wiring time and fails or warns on a mismatch. This page is the single
index of all of them: what each integer means, its current value, where it is
asserted, and what changing it obligates.

These integers are **not** the published (npm) version. Every package in the fleet
ships as `1.0.0`; the contract integers below move on their own cadence when a
surface changes shape. See [Everything ships in 1.0](/reference/stability) for why.

<Callout type="tip" title="One rule, applied at three altitudes">
The Satellite ABI, the plugin API, and each surface's extension contract all use
the same asymmetric compatibility rule: **newer than the host provides → fail;
older → warn and run degraded; equal → ok; absent → warn (unversioned)**. Learn it
once in the [Extensibility standard](/guides/extensibility) and it applies
everywhere below.
</Callout>

## Fleet-wide axes

Two integers describe whether a whole satellite fits the core it is installed
against. Both are exported from core's public SDK.

| Constant | Value | Import | Answers | Asserted |
|---|---|---|---|---|
| `SATELLITE_API_VERSION` | `1` | `@adonisjs-lasagna/saas-tenancy/sdk` | "Does this satellite fit this **core**?" — the extension registries, the manifest shape, and the configure contract. | `configure` (against `package.json#lasagnaSatellite.satelliteApi`) and, at boot, `assertSatelliteApiCompatAtBoot` / the `definePlugin` facade. |
| `PLUGIN_API_CONTRACT_VERSION` | `1` | `@adonisjs-lasagna/saas-tenancy/plugin` | "Does this satellite fit the **`definePlugin` facade** contract?" — the declarative spec shape the facade consumes. | The `definePlugin` facade at boot, mirrored against `package.json#lasagnaSatellite.pluginApiVersion`. |

`LASAGNA_PLUGIN_API_VERSION` is the alias you declare in a plugin spec; it is the
same integer as `PLUGIN_API_CONTRACT_VERSION` (the facade exports both so the
declaration site reads well). A hand-written provider calls
`assertSatelliteApiCompatAtBoot(...)` itself; the facade does it for you.

## Per-surface extension contracts

Each pluggable surface exports a `*_CONTRACT_VERSION`. An extension you register
declares the `contractVersion` it was built against, and the surface's registry
compares the two at `register()`. This is the same rule as the Satellite ABI, one
level down: it answers "does this **extension** fit this **surface**?".

### Core surfaces

| Constant | Value | Surface | Registry |
|---|---|---|---|
| `ISOLATION_CONTRACT_VERSION` | `2` | [custom isolation drivers](/guides/cookbook/custom-isolation-driver) | `IsolationDriverRegistry` |
| `RESOLVER_CONTRACT_VERSION` | `1` | custom tenant resolvers | `TenantResolverRegistry` |
| `AUTHORIZER_CONTRACT_VERSION` | `1` | [tenant-access authorizers](/guides/plugins) | `AuthorizerRegistry` |
| `TENANT_MIDDLEWARE_CONTRACT_VERSION` | `1` | [route middleware](/guides/plugins) | `TenantMiddlewareRegistry` |
| `CAPABILITY_CONTRACT_VERSION` | `2` | [cross-plugin capabilities](/guides/plugins) | `CapabilityRegistry` |
| `AUDIT_CONTRACT_VERSION` | `1` | [log destinations](/guides/satellites/audit) | `AuditLogDestinationRegistry` |
| `FEATURE_FLAGS_CONTRACT_VERSION` | `1` | [evaluation strategies](/guides/satellites/feature-flags) | `EvaluationStrategyRegistry` |
| `WEBHOOKS_CONTRACT_VERSION` | `1` | [payload transformers](/guides/satellites/webhooks) | `WebhookTransformerRegistry` |

### Satellite surfaces

| Constant | Value | Surface | Registry / seam | Import |
|---|---|---|---|---|
| `BILLING_CONTRACT_VERSION` | `1` | [payment drivers](/guides/satellites/billing) | `BillingDriverRegistry` | `@adonisjs-lasagna/billing` |
| `REPORTING_CONTRACT_VERSION` | `1` | [custom reports](/guides/satellites/reporting) | `ReportExtensionRegistry` | `@adonisjs-lasagna/reporting` |
| `WEBSOCKETS_CONTRACT_VERSION` | `1` | [authorize hook](/guides/satellites/websockets) | config `authorize` | `@adonisjs-lasagna/websockets` |
| `ADMIN_CONTRACT_VERSION` | `1` | [custom actions](/guides/satellites/admin) | `adminActionRegistry` | `@adonisjs-lasagna/admin` |
| `SSO_CONTRACT_VERSION` | `1` | [identity providers](/guides/satellites/sso) | `identityProviderRegistry` | `@adonisjs-lasagna/sso` |
| `AI_CONTRACT_VERSION` | `1` | [AI providers](/guides/satellites/ai) | `AIProviderRegistry` | `@adonisjs-lasagna/ai` |
| `CRYPTO_CONTRACT_VERSION` | `1` | [key providers](/guides/satellites/crypto) | `KeyProviderRegistry` | `@adonisjs-lasagna/crypto` |

The two surfaces already at `2` (`ISOLATION_CONTRACT_VERSION`,
`CAPABILITY_CONTRACT_VERSION`) each took one backward-incompatible revision; every
other contract is still on its first, unbroken revision.

## When to bump

Bump a contract integer only on a **backward-incompatible** change to that surface:
a removed or renamed field an extension relied on, a changed method signature, a
new required capability. Additive changes (a new optional field, a new helper) do
not bump it. When you bump one:

- Record the change in the [CHANGELOG](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/CHANGELOG.md)
  with the old → new behavior, so an extension author on the old contract knows what
  the `warn` path now degrades.
- Leave the value as the single source of truth. This page snapshots the current
  numbers for orientation; the exported constant is authoritative, so read it in
  code (`import { CRYPTO_CONTRACT_VERSION } from '@adonisjs-lasagna/crypto'`) rather
  than hardcoding an integer.

<Callout type="note" title="Not a contract version">
`DEFAULT_STRIPE_API_VERSION` (billing) is a Stripe API date string, not a Lasagna
contract integer. It pins the upstream Stripe API and follows Stripe's calendar,
not this scheme.
</Callout>

## Read next

- [Extensibility standard](/guides/extensibility); the one compatibility rule these
  integers all follow, and how a surface checks an extension at `register()`.
- [Building a plugin](/guides/plugins); the `definePlugin` facade that declares
  `satelliteApi` and `pluginApiVersion` for you.
- [Creating a satellite](/guides/cookbook/creating-a-satellite); how a packaged
  satellite declares the Satellite ABI it targets.
- [Stability](/reference/stability); which surfaces are covered by the 1.x semver
  promise, and how the contract integers relate to the npm version.

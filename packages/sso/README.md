# @adonisjs-lasagna/sso

Per-tenant OIDC / SSO for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
OIDC discovery (with SSRF + issuer checks), authorization-URL building,
callback verification (signature, `iss`/`aud`/`exp`, nonce), and the
`TenantSsoConfig` model.

[![Stability: release candidate](https://img.shields.io/badge/stability-release_candidate-C26A4B)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability)

> **Stability: release candidate.** The API is frozen under the 1.x promise, with the honest caveat that a correction forced by the pending security review or production mileage may land in a 1.x minor with a loud changelog entry. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability).

It was split out of the core so SSO versions on its own cadence and is only
installed by apps that use it. `jose` is an optional peer — install it to enable
id_token verification.

## Install

```bash
npm i @adonisjs-lasagna/sso @adonisjs-lasagna/saas-tenancy jose
node ace configure @adonisjs-lasagna/sso
node ace migration:run --connection=backoffice
```

`@adonisjs-lasagna/saas-tenancy` (the core) is a required peer. `node ace
configure` publishes this package's `tenant_sso_configs` migration — SSO owns the
migration and registers no provider. The table lives in the shared `backoffice`
schema, so run `migration:run --connection=backoffice` afterwards.

## Usage

```ts
import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'

const sso = new SsoService()
await sso.upsertConfig(tenantId, { clientId, clientSecret, issuerUrl, redirectUri })
const url = await sso.buildAuthUrl(await sso.getConfig(tenantId))
// ...later, on the callback route:
const { tenantId, claims } = await sso.handleCallback(state, code)
```

`SsoService` takes no constructor dependencies, so `new SsoService()` is fine;
resolve it from the container (`await app.container.make(SsoService)`) if you
prefer the DI form used elsewhere.

## Migrating from the core barrels

Before the split `SsoService` and `TenantSsoConfig` were exported from the core:

```diff
- import { SsoService } from '@adonisjs-lasagna/saas-tenancy/services'
- import { TenantSsoConfig } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
+ import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'
```

The `tenant_sso_configs` migration ships with **this package** and is published by
`node ace configure @adonisjs-lasagna/sso` (equivalently `--with=sso` via the core
configure hook, which requires this package to be installed). It used to ship from
the core; it now lives here.

## Extending

Bring your own identity provider through the exported registry:
`identityProviderRegistry`, the `IdentityProviderContract` interface, and
`SSO_CONTRACT_VERSION` (all from `@adonisjs-lasagna/sso`). See the
[SSO guide](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/sso)
for the walkthrough.

## Full documentation

<https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/guides/satellites/sso>

# @adonisjs-lasagna/sso

Per-tenant OIDC / SSO for
[`@adonisjs-lasagna/saas-tenancy`](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy):
OIDC discovery (with SSRF + issuer checks), authorization-URL building,
callback verification (signature, `iss`/`aud`/`exp`, nonce), and the
`TenantSsoConfig` model.

[![Stability: experimental](https://img.shields.io/badge/stability-experimental-E0A106)](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/stability)

> **Experimental.** This satellite works and is covered by tests, but it is not part of the 1.x stability promise: its surface may change in a minor release. Pin the version and read the changelog before upgrading. See the [stability matrix](https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/stability).

It was split out of the core so SSO versions on its own cadence and is only
installed by apps that use it. `jose` is an optional peer — install it to enable
id_token verification.

## Install

```bash
npm i @adonisjs-lasagna/sso jose
```

It declares `@adonisjs-lasagna/saas-tenancy` as a peer, so install the core
package too.

## Usage

```ts
import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'

const sso = new SsoService()
await sso.upsertConfig(tenantId, { clientId, clientSecret, issuerUrl, redirectUri })
const url = await sso.buildAuthUrl(await sso.getConfig(tenantId))
// ...later, on the callback route:
const { tenantId, claims } = await sso.handleCallback(state, code)
```

## Migrating from the core barrels

Before the split `SsoService` and `TenantSsoConfig` were exported from the core:

```diff
- import { SsoService } from '@adonisjs-lasagna/saas-tenancy/services'
- import { TenantSsoConfig } from '@adonisjs-lasagna/saas-tenancy/models/satellites'
+ import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'
```

The `tenant_sso_configs` migration still ships with the core configure hook
(`--with=sso`), since it is plain SQL independent of the model.

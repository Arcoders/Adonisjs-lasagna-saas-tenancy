# Changelog

All notable changes to `@adonisjs-lasagna/sso` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-08

Initial standalone release. The per-tenant OIDC/SSO surface was extracted from
`@adonisjs-lasagna/saas-tenancy` so it versions on its own and is only installed by apps
that use it. It depends on the core as a peer (`^1.0.0`).

**Stability: experimental.** The API is covered by tests but may change in a minor release.
Pin the version and read this changelog before upgrading. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/docs/stability.md).

### Added

- `SsoService`: per-tenant OIDC discovery, authorization-URL building, and callback
  verification. JWKS-backed ID-token verification with nonce/state binding. The server-side
  fetch targets pulled from the tenant-controlled discovery document (`token_endpoint`,
  `jwks_uri`) go through the core's DNS-resolving SSRF guard, not just the syntactic one.
- `TenantSsoConfig`: the backoffice-schema model that stores a tenant's OIDC configuration.
- `IdTokenClaims` type for the verified-claims payload.

### Migration from core 0.2.x

`SsoService` and `TenantSsoConfig` were previously exported from the core's shared barrels.
They were removed from the core with no shim (the symbols are gone), so update imports to
`@adonisjs-lasagna/sso` and register the package per its README.

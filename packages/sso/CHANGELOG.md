# Changelog

All notable changes to `@adonisjs-lasagna/sso` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-19

Graduated to `release candidate` and versioned `1.0.0` (see the stability matrix).
The API is considered final; `release candidate` (not `stable`) reflects the two
still-open items shared with the core, an independent security review and
production mileage.

- **Security-critical core unit-tested.** Added a unit suite over `SsoService`
  covering the atomic GETDEL state consumption (CSRF/replay), the SSRF guards on
  issuer / token_endpoint / jwks_uri, the discovery issuer-mismatch check, and the
  id_token nonce check. The service gained an injectable deps seam (an optional
  constructor argument plus the exported `SsoServiceDeps` type) so these run
  without a database, Redis or a real IdP. The public surface is unchanged for
  callers: `container.make(SsoService)` constructs it argument-free.
- **Clear error when `jose` is absent.** The OIDC callback path surfaces an
  explicit, actionable error when the optional `jose` peer is not installed.
- **Coverage gate added** (`.c8rc.json`, `check-coverage: true`) over the service.
- **The package now owns its own migrations.** The SSO migration stubs were
  previously published from the core; they now ship with this package and are
  installed through the satellite mechanism. Existing apps are unaffected (their
  migrations are already committed), but a fresh install is now
  `node ace configure @adonisjs-lasagna/sso` (equivalently `--with=sso`, which
  requires the package to be installed).

**Stability: release candidate.** The API is frozen under the 1.x promise, with the
honest caveat that a correction forced by the pending security review or production
mileage may land in a 1.x minor with a loud changelog entry.

## [0.1.0] — 2026-06-08

Initial standalone release, versioned `0.x` to match its `experimental` stability
label (see the stability matrix): the surface may change in any minor. The per-tenant OIDC/SSO surface was extracted from
`@adonisjs-lasagna/saas-tenancy` so it versions on its own and is only installed by apps
that use it. It depends on the core as a peer (`^1.0.0`).

**Stability: experimental.** The API is covered by tests but may change in a minor release.
Pin the version and read this changelog before upgrading. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/reference/stability.md).

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

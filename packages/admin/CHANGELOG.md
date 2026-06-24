# Changelog

All notable changes to `@adonisjs-lasagna/admin` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-19

Graduated to `release candidate` and versioned `1.0.0` (see the stability matrix).
Admin also became a first-class satellite: a `lasagnaSatellite` manifest at the
frozen Satellite ABI and a guidance-only `adonisjs.configure` hook that prints the
mount snippet (it never edits your routes file).

- **SSO peer is now lazy (no hard coupling).** `@adonisjs-lasagna/sso` was imported
  at module load, so admin failed to load when sso was not installed despite
  declaring it optional. The SSO controller now imports sso lazily and the SSO
  endpoints return **501** when it is absent; the rest of the admin API works
  without it. The `sso` peer range moved to `^1.0.0`.
- **Access model documented.** Clarified the CSRF responsibility (delegated to the
  host), the Swagger/OpenAPI gating (`docsAuth`), and the fail-closed mount in the
  docs.
- **Coverage gate added** (`.c8rc.json`, `check-coverage: true`) over the
  unit-testable security logic (the fail-closed mount guard).
- **Feature-flag expiry on the admin API.** The feature-flags `POST`/`PUT`
  endpoints accept an optional `expiresAt` (ISO 8601); an invalid value returns
  `400 invalid_expires_at`, and omitting it clears any stored expiry. Responses
  now include an `expiresAt` field.

**Stability: release candidate.** The API is frozen under the 1.x promise, with the
honest caveat that a correction forced by the pending security review or production
mileage may land in a 1.x minor with a loud changelog entry.

## [0.1.0] — 2026-06-08

Initial standalone release, versioned `0.x` to match its `experimental` stability
label (see the stability matrix): the surface may change in any minor. The REST admin API was extracted from
`@adonisjs-lasagna/saas-tenancy` so the admin surface versions independently and is only
installed by apps that mount it. It depends on the core (`^1.0.0`) and on
`@adonisjs-lasagna/sso` (`^0.1.0`) as peers.

**Stability: experimental.** The API is covered by tests but may change in a minor release.
Pin the version and read this changelog before upgrading. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/docs/stability.md).

### Added

- `AdminController` and `multitenancyAdminRoutes`: tenant CRUD, impersonation, and satellite
  management. 36 endpoints with an OpenAPI 3.1 spec and Swagger UI.
- `AdminRouteMiddleware` and `AdminActorResolver` types so the host supplies its own auth.
  `AdminRouteMiddleware` accepts a string, a bare function, or a named-middleware reference
  (`router.named(...)` / the `middleware.adminAuth()` shape), matching what `multitenancyAdminRoutes`
  always accepted at runtime.

### Security

- The mount is **fail-closed**. `multitenancyAdminRoutes` throws at boot unless you pass
  `middleware`, or `middleware: false` to mount it public on purpose. `middleware: null` is
  treated as fail-closed (like omitting it), not as the explicit public opt-out.

### Migration from core

`@adonisjs-lasagna/saas-tenancy/admin` is a deprecated throwing shim for one minor, then
drops. Install `@adonisjs-lasagna/admin` and import `multitenancyAdminRoutes` from it.

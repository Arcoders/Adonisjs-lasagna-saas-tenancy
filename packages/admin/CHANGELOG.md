# Changelog

All notable changes to `@adonisjs-lasagna/admin` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

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

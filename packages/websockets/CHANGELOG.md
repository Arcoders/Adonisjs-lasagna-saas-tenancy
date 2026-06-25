# Changelog

All notable changes to `@adonisjs-lasagna/websockets` are documented here.

This project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] — 2026-06-19

Graduated to `release candidate` and versioned `1.0.0` (see the stability
matrix). The API is considered final; `release candidate` (not `stable`) reflects
the two still-open items shared with the core, an independent security review and
production mileage.

- **Multi-node severance recipe.** Documented the in-process limitation of
  suspend/delete severance and added a concrete, copyable recipe for fan-out and
  cross-node severance over the socket.io Redis adapter plus a Redis pub/sub
  bridge. The `TenantSocketServer` now exposes the attached socket.io `Server` via
  a public `io` getter so a host can wire the adapter and the bridge.
- **Coverage gate.** Added an own `.c8rc.json` (`check-coverage: true`) over the
  handshake resolution and per-event tenant binding, run as `test:coverage` in CI.

### Fixed

- **Type resolution for the `/provider` subpath.** Added the missing
  `typesVersions` entry so the `/provider` export's declarations resolve under
  `node10`-style module resolution (it previously declared the subpath in
  `exports` without a matching types map, which `arethetypeswrong` flagged).

**Stability: release candidate.** The API is frozen under the 1.x promise, with
the one honest caveat that a correction forced by the pending security review or
production mileage may land in a 1.x minor with a loud changelog entry. See the
[stability matrix](https://github.com/Arcoders/Adonisjs-lasagna-saas-tenancy/blob/master/docs/reference/stability.md).

## [0.1.0] — 2026-06-18

Initial standalone release of the multi-tenant WebSockets satellite: socket.io
with per-tenant handshake resolution, per-event tenant-context binding, and
tenant-scoped rooms. It depends on the core as a peer (`^1.0.0`); `socket.io` is
an optional peer dependency, and `@socket.io/redis-adapter` is optional for
multi-node fan-out.

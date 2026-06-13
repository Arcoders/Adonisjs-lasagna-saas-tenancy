# Testing guide

This covers how to run the suite locally and in CI, where the hardening tests live, and what
passing them does and does not promise. For the feature-to-spec map see
[COVERAGE_MATRIX.md](./COVERAGE_MATRIX.md); for accuracy notes and known gaps see
[MISSING_FEATURES.md](./MISSING_FEATURES.md).

## Layers

The repository tests at three altitudes:

- **Unit** (`packages/core/tests/unit`, `packages/core/tests/architectural`) run against source
  with `tsx`, no database required for most.
- **Integration** (`packages/core/tests/integration`) boot a real AdonisJS Ignitor against a real
  PostgreSQL and Redis, and run against the compiled `./build`.
- **End-to-end** (`examples/api/tests/e2e`) drive the demo app over HTTP. The hardening suite
  added by this effort lives in `examples/api/tests/e2e/hardening/`.

The production-guarantee tests (isolation, quota atomicity, circuit breaker, audit immutability)
all use real PostgreSQL and Redis. The in-memory `sqlite-memory` driver is only used by fast unit
lifecycle tests, never by the hardening specs.

## Prerequisites

- Node.js >= 24.
- Docker (for the local PostgreSQL + Redis used by integration and e2e).
- `pg_dump` / `pg_restore` / `psql` on PATH for the backup specs (those specs skip cleanly when
  the tools are absent).

## Running

### Unit and integration (core package)

```bash
npm run test                  # unit + architectural
npm run test:coverage         # unit under c8 (enforces the coverage floors)
npm run test:integration      # builds, then runs integration against ./build
```

Integration and e2e expect PostgreSQL on `127.0.0.1:55432` and Redis on `127.0.0.1:56379` (the
ports the demo's `docker-compose.yml` publishes). In CI they run against the workflow's service
containers on the standard ports.

### End-to-end (demo app)

```bash
cd examples/api
npm run infra:up                       # docker compose: postgres, redis, mailcatcher
npx tsx ace.ts backoffice:setup        # create the backoffice schema + run migrations
npx tsx ace.ts test e2e                # full e2e suite
npx tsx ace.ts test e2e --files hardening   # only the hardening suite
```

`npm run test:e2e` (or `test:e2e:win` on PowerShell) wraps all of the above: it brings infra up,
runs `backoffice:setup`, runs the suite, and tears infra down.

### Mutation testing

Stryker targets the two highest-value logic units (quota and resolvers):

```bash
cd packages/core
npx stryker run
```

The configuration is report-only; the 80% threshold is a target surfaced in the report, not a
hard CI break.

## CI

`.github/workflows/ci.yml` runs unit and integration against `postgres:16`, `redis:7`, and a mock
OIDC server, and an `e2e` job runs the demo app's suite (`backoffice:setup` then `test e2e`)
against the same services. Specs that need optional dependencies (mock OIDC, `pg_dump`) skip
themselves when those are unavailable, so the suite stays green rather than flaky.

## Audit immutability pen-test

The append-only guarantee on `backoffice.tenant_audit_logs` is enforced by PostgreSQL triggers.
Every statement below must be rejected (the trigger raises with `ERRCODE = insufficient_privilege`)
while plain `INSERT` stays allowed. `e2e/hardening/audit_immutability.spec.ts` runs exactly these
attempts and asserts each one fails.

```sql
-- Allowed: append a record.
INSERT INTO backoffice.tenant_audit_logs (tenant_id, actor_type, action)
VALUES (gen_random_uuid(), 'system', 'probe') RETURNING id;

-- FORBIDDEN: tamper with history. Each raises 'tenant_audit_logs is append-only ...'.
UPDATE backoffice.tenant_audit_logs SET action = 'tampered' WHERE id = '<id>';
DELETE FROM backoffice.tenant_audit_logs WHERE id = '<id>';
TRUNCATE TABLE backoffice.tenant_audit_logs;
```

## Responsibility contract

When the `hardening/` suite and the authoritative specs it references all pass green in CI
against real PostgreSQL and Redis, the application is verified to resist these documented failure
modes:

- no cross-tenant data leakage under concurrent, interleaved HTTP load;
- quota enforcement is atomic, with no over-grant under burst (exact success/failure counts);
- SSO state cannot be replayed: concurrent consumers of one state produce exactly one winner;
- rate limiting fails closed (503) when Redis is down, unless `failOpen` is explicitly set;
- user-supplied identifiers cannot reach DDL unchecked (`assertSafeIdentifier` plus a CI lint);
- the audit log is append-only at the database level (UPDATE/DELETE/TRUNCATE are rejected);
- one tenant's open circuit fails only that tenant, never its neighbours;
- backup/restore/clone/import are serialized per tenant: a concurrent same-tenant operation is
  rejected (409) instead of overlapping.

This contract is deliberately bounded. It does **not** claim coverage of the items listed in
[MISSING_FEATURES.md](./MISSING_FEATURES.md), notably: `tenant:doctor --watch` and `tenant:repl`
are interactive and exercised by hand, and the per-tenant backup lock fails open when Redis is
unavailable (the operation proceeds unserialised, logged) rather than blocking every backup.
Passing the suite is strong evidence, not a substitute for load testing your own application code
on top of the package.

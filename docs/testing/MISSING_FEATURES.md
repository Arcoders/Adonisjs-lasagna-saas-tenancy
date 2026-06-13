# Findings, gaps, and documentation corrections

The brief asked us to flag anything documented but missing, incomplete, or described
inaccurately. Each item below was checked against source, not assumed. None of these block the
hardening guarantees; they are accuracy notes so the test suite never asserts something the
code does not actually do.

## Corrections to the brief's API claims

1. **`tenancy.initialize()` does not exist.** The imperative API is `tenancy.run(ctx, fn)`,
   `tenancy.current()`, and `tenancy.currentId()` (`packages/core/src/tenancy.ts`). There is no
   separate `initialize()`; `run()` is how you enter a tenant context in jobs, commands, and
   tests. Tests use `tenancy.run()` accordingly.

2. **Quota-exceeded HTTP status is 429.** `QuotaExceededException.status` is `429` with code
   `E_TENANT_QUOTA_EXCEEDED` (`packages/core/src/exceptions/quota_exceeded_exception.ts`). The
   demo's exception handler remaps it to the response body
   `{ error: { code: 'QUOTA_EXCEEDED', details: { quota, limit, current, attempted } } }` with a
   `Retry-After: 60` header (`examples/api/app/exceptions/handler.ts`). The hardening quota test
   asserts the response code `QUOTA_EXCEEDED`, which is the app-level code, not the exception's
   internal `E_TENANT_QUOTA_EXCEEDED`.

3. **The Admin API has 36 endpoints, not "31+".** Enumerated from
   `packages/admin/src/routes.ts` (includes `/openapi.json` and `/docs`). "31+" is technically
   satisfied but imprecise.

4. **OpenAPI is generated at runtime; there is no static spec file.** `GET {prefix}/openapi.json`
   builds the 3.1 document on each request via `getOpenAPISpec()`
   (`packages/admin/src/openapi.ts`). The default prefix is `/admin/multitenancy`; the demo app
   mounts it at `/admin`.

5. **Audit immutability protects a backoffice table, not a per-tenant-schema table.** The audit
   log is `backoffice.tenant_audit_logs` (a shared backoffice satellite table). The brief's
   wording "from within the tenant's own schema" is inaccurate. The triggers
   (`tenant_audit_logs_no_update/_delete/_truncate` → `backoffice.tenant_audit_logs_no_mutate()`)
   guard against a compromised tenant role or a buggy controller rewriting the shared log.

## Gaps found and how they were handled

6. **The demo's audit migration originally omitted the immutability triggers.** The package's
   canonical migration stub
   (`packages/core/stubs/migrations/create_tenant_audit_logs_table.stub`) ships the append-only
   triggers, but the demo's hand-written migration
   (`examples/api/database/migrations/backoffice/0002_create_tenant_audit_logs_table.ts`) created
   the table without them, so audit logs in the demo were mutable. This was a real inconsistency.
   It has been fixed by adding the same triggers to the demo migration, and
   `e2e/hardening/audit_immutability.spec.ts` additionally re-asserts them idempotently in setup
   so the guarantee holds even on a database migrated before the fix.

7. **Backup / restore concurrency lock — was missing, now implemented.** Originally no advisory
   lock or mutex existed in the backup package, so two `tenant:backup` (or backup vs restore)
   invocations against the same tenant could overlap and corrupt each other. This is now a real
   guarantee: `withTenantOperationLock`
   (`packages/backup/src/services/tenant_operation_lock.ts`) wraps `BackupService.backup`,
   `BackupService.restore`, `CloneService.clone`, and `SqlImportService.import`. It is a per-tenant
   Redis lock (`SET key token NX PX ttl`) with TTL renewal for long backups and a compare-and-delete
   release. A concurrent second operation on the same tenant is rejected fast with
   `TenantOperationLockedException` (HTTP status 409) instead of overlapping; operations on
   different tenants never block each other. The command and job paths inherit it because both
   delegate to those services. Proven by `e2e/hardening/backup_lock.spec.ts`. One honest caveat:
   the lock fails open when Redis is unavailable (the operation proceeds unserialised, logged as a
   warning) rather than blocking every operator-initiated backup when the coordination layer is
   down.

## Things that are real but not automatable here

8. **`tenant:doctor --watch` is a TUI.** It redraws a dashboard on an interval and exits on
   SIGINT (`packages/core/src/commands/tenant_doctor.ts`). The machine-readable surface for CI is
   `--json`, which is covered. `--watch` is exercised manually.

9. **`tenant:repl` is interactive.** It opens a REPL bound to a tenant connection and is not
   driven from an automated spec.

10. **`sqlite-memory` isolation driver exists** (`packages/core/src/services/isolation/...`) and is
    covered by `core/integration/isolation/sqlite_memory_lifecycle.spec.ts`, but per the brief's
    rule it is deliberately excluded from the isolation/quota/concurrency hardening specs, which
    all run against real PostgreSQL.

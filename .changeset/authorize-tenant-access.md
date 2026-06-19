---
"@adonisjs-lasagna/saas-tenancy": minor
---

Add an opt-in `authorizeTenantAccess` hook to the tenant guard so hosts have a first-class
place to enforce tenant membership. The package routes by tenant id and verifies the tenant
exists and is active, but it never checked that the authenticated caller belongs to the
resolved tenant, leaving the classic cross-tenant IDOR (a swapped `x-tenant-id` served
against another tenant's schema) entirely to the host, and undocumented.

The hook runs in `TenantGuardMiddleware` after the lifecycle check and before the
operational checks: returning `false` (or throwing) yields a 403
`TenantAccessForbiddenException`; when unset, behavior is unchanged. It is a membership
check (the first line of defense), not full RBAC. Ships with a `createTestAuthzContext`
testing helper (from `@adonisjs-lasagna/saas-tenancy/testing`), an `@adonisjs/auth` example,
a new "What the host owns" row plus hardening-checklist item in the security docs, and a
real-PostgreSQL integration spec proving a tenant-id swap is rejected with 403.

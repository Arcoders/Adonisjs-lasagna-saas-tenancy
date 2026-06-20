---
"@adonisjs-lasagna/admin": patch
"@adonisjs-lasagna/backup": patch
"@adonisjs-lasagna/billing": patch
---

Internal: resolve the host tenant repository through core's new
`resolveTenantRepository()` helper instead of an inline
`container.make(TENANT_REPOSITORY as any)` cast. No behavior or API change.

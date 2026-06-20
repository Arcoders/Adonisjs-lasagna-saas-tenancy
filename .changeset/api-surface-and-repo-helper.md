---
"@adonisjs-lasagna/saas-tenancy": minor
---

Tighten the public API surface and remove resolve-cast boilerplate ahead of 1.0.

- **New `resolveTenantRepository()` helper** (exported from
  `@adonisjs-lasagna/saas-tenancy/services` and the package root). It centralizes the one
  unavoidable `container.make(TENANT_REPOSITORY as any)` cast that was copy-pasted across ~40
  commands, jobs, middleware, and satellites — the container can't infer a return type from a
  `Symbol` DI token, so the cast now lives in exactly one place and every call site gets a
  properly typed `TenantRepositoryContract` instead.
- **Curated root barrel.** The concrete built-in isolation drivers (`SchemaPgDriver`,
  `DatabasePgDriver`, `RowScopePgDriver`, `SqliteMemoryDriver`) and resolver classes
  (`HeaderResolver`, `SubdomainResolver`, `PathResolver`, `DomainOrSubdomainResolver`,
  `RequestDataResolver`, `ResolverHit`, `builtInResolvers`) are now exported from
  `@adonisjs-lasagna/saas-tenancy/services` only, not the package root. Apps pick a driver by
  config (`isolation.driver`) and resolvers via `TenantResolverRegistry`, so this only affects
  code that imported those implementation classes directly — switch such imports to the
  `/services` subpath. The extension registries (`IsolationDriverRegistry`,
  `TenantResolverRegistry`) stay on the root. A new architectural test keeps the root barrel
  from drifting out of sync with `/services`.
- **Boot-time numeric config validation.** The provider now range-checks the numeric tunables
  (connection caps, eviction grace windows, circuit-breaker threshold, queue sizes,
  impersonation durations, ...). A misconfiguration like `isolation.maxTenantConnections: 0` or
  a circuit `threshold` outside 1..100 fails fast at boot with a clear message instead of
  misbehaving at runtime.
- **Complete `shutdown()`.** `MultitenancyProvider.shutdown()` now also resets the
  request-resolution caches (resolver registry + resolution cache), so a provider re-boot in
  the same process (hot reload, or a test reusing the container) can't serve a stale resolver
  or cached tenant.

No runtime behavior change for correctly-configured apps beyond the import-path move noted
above.

---
"@adonisjs-lasagna/saas-tenancy": patch
---

Fix: the opt-in tenant-resolution cache (`resolver.cache.enabled`) never evicted on
tenant-lifecycle events, so a suspend / maintenance / delete only took effect once the
TTL expired instead of immediately.

`MultitenancyProvider` wired the invalidation listeners in `boot()` by importing the
`@adonisjs/core/services/emitter` module. That module only assigns its export inside an
`app.booted()` hook, which has not run during `boot()`, so the import resolved to
`undefined` and every subscription was silently skipped. The wiring now runs in
`ready()` (after the app is booted) and resolves the emitter from the container, so
lifecycle events drop the cached tenant on this pod the moment they fire. The logic was
extracted to a unit-tested `wireResolutionCacheInvalidation` helper. No effect when the
cache is off (the default).

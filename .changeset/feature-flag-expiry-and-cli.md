---
"@adonisjs-lasagna/saas-tenancy": minor
"@adonisjs-lasagna/admin": minor
---

Feature-flag expiry + reads, branding context helper, and safer interactive doctor fixes.

Core (`@adonisjs-lasagna/saas-tenancy`):

- `FeatureFlagService.getFlag(tenantId, flag)` returns the raw stored record
  `{ enabled, config, expiresAt } | null` — a faithful data accessor (does NOT
  apply expiry) for reading a flag's `config` (e.g. a rollout percentage)
  without listing every flag.
- Feature flags now support temporal expiry. `tenant_feature_flags` gains a
  nullable `expires_at` column and `set()` takes an optional `expiresAt`
  (`DateTime | null`). Once the deadline passes, `isEnabled()` returns false —
  expiry is compared at read time, so it's exact regardless of the 60s cache.
  Re-run `node ace configure @adonisjs-lasagna/saas-tenancy --with=feature_flags`
  on a fresh install, or add the column to an existing table.
- The per-tenant flag cache key changed (`ff_map:` → `ffm2:`) because the cached
  value shape changed from a bare boolean to a record; this keeps a rolling
  deploy from mis-reading entries. Old entries age out on their own.
- New CLI: `tenant:feature-flag:set|get|list|delete`. `get`/`list` read the
  database directly; `set`/`delete` invalidate the shared cache (need Redis).
- `BrandingService.getCurrent()` resolves the active tenant from the ambient
  `tenancy` context (HTTP request or `tenancy.run(...)`), mirroring
  `tenantMailer()`. Throws outside a tenant scope.
- `tenant:doctor --fix --interactive` confirms before fixing each check (per
  check, not per issue — the DoctorCheck contract is unchanged). Ignored under
  `--watch`/`--json`; a no-op without `--fix`.

Admin (`@adonisjs-lasagna/admin`):

- The feature-flags `POST`/`PUT` endpoints accept an optional `expiresAt` (ISO
  8601); an invalid value returns `400 invalid_expires_at`, and omitting it
  clears any stored expiry. Responses now include an `expiresAt` field.

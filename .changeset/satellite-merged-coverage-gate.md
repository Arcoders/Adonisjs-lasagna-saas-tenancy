---
"@adonisjs-lasagna/admin": patch
"@adonisjs-lasagna/sso": patch
"@adonisjs-lasagna/billing": patch
"@adonisjs-lasagna/backup": patch
"@adonisjs-lasagna/websockets": patch
---

Add a declared per-satellite merged-coverage floor to each satellite manifest
(`lasagnaSatellite.minMergedCoverage`) plus a CI gate
(`scripts/check-satellite-coverage.mjs`) that enforces each satellite's MERGED
(unit + integration) source coverage against it. This makes the `release
candidate` label backed by a real per-package number, not just the repo-wide
aggregate, and it respects that controller-heavy satellites (admin) are exercised
by the integration tier rather than by unit tests. The graduation gate now also
requires the floor to be declared at the bar. No public API or runtime behavior
change; the manifest field is internal tooling metadata.

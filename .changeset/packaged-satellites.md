---
"@adonisjs-lasagna/saas-tenancy": minor
"@adonisjs-lasagna/billing": minor
"@adonisjs-lasagna/sso": minor
---

Packaged satellites — a public extension platform for third-party satellites.

Core:

- New `@adonisjs-lasagna/saas-tenancy/sdk` subpath: the `SatelliteManifest`
  + `SatelliteProviderContract` types and a configure toolkit
  (`discoverSatellites`, `publishSatellite`, `registerSatelliteInRcFile`,
  `printSatelliteManifest`, plus the migration-publishing helpers).
- `node ace configure @adonisjs-lasagna/saas-tenancy` gains `--list-satellites`
  (discover installed satellites) and `--with=<package>` (publish an external
  satellite's migrations, register its provider/commands, print its config). A
  satellite is any installed package declaring a `lasagnaSatellite` key in its
  `package.json`.
- The `/testing` barrel is now safe to import in a hermetic unit test (it no
  longer boots a DB connection at import time), so satellite authors can use the
  test helpers without an Ignitor. The in-memory test-double pattern is shown in
  the new cookbook and shipped as a small, copyable `InMemoryStore` in the
  satellite template.

Billing & SSO now own their migrations through this mechanism (previously
published from core). **Behavioral note:** existing apps are unaffected (their
migrations are already committed), but `--with=billing` / `--with=sso` now
require the package to be installed — the canonical install is
`node ace configure @adonisjs-lasagna/<name>`.

See the new "Creating a satellite" cookbook for the full guide.

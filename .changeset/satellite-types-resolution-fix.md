---
"@adonisjs-lasagna/billing": patch
"@adonisjs-lasagna/backup": patch
"@adonisjs-lasagna/websockets": patch
---

Fix type resolution for the `/provider` and `/commands` subpath exports. These
packages declared the subpaths in `exports` but had no matching `typesVersions`
entries, so a consumer on `node10`-style module resolution could not resolve
their type declarations (surfaced by `arethetypeswrong`). Added `typesVersions`
mirroring the core package. CI now gates every publishable package with
`publint` + `arethetypeswrong`.

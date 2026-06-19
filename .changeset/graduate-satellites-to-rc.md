---
"@adonisjs-lasagna/saas-tenancy": minor
---

Graduate the Satellite ABI (`/sdk`) from `experimental` to `release candidate`.
`SATELLITE_API_VERSION = 1` is now a frozen contract under the 1.x promise: an
incompatible ABI change ships as a version bump that `checkSatelliteApiCompat`
rejects against an older core, never as a silent break in a minor.

Core changes in this release:

- The `/sdk` row in the stability matrix moves to `release candidate`, with a note
  describing exactly what the ABI freeze covers (the core registries a satellite
  self-registers into, the `lasagnaSatellite` manifest shape, and the
  `SatelliteProviderContract` / configure-toolkit signatures).
- `config.multitenancy.backup` gains `lockFailOpenOnDestructive?: boolean` so a
  host can opt the backup satellite's destructive operations back into the legacy
  fail-open locking.
- A new `scripts/check-satellite-graduation.mjs` CI gate enforces that any
  satellite labeled `release candidate` carries its own coverage gate,
  ABI-versioned manifest, configure hook, CHANGELOG and doc page.

The five publishable satellites (billing, sso, backup, websockets, admin) graduated
to `release candidate` / `1.0.0` in the same pass; each change is recorded in that
package's own CHANGELOG (notably the billing per-tenant usage-event migration and
the backup fail-closed lock).

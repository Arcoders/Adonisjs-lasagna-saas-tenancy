---
"@adonisjs-lasagna/saas-tenancy": minor
---

Harden the packaged-satellite extension surface ahead of freezing it for a
third-party ecosystem. The `/sdk` extension point is now labelled **experimental**
(see the stability matrix) until its ABI is frozen and contract-tested.

- **Satellite ABI versioning.** Core now exports `SATELLITE_API_VERSION` (a single
  monotonic integer, currently `1`) and `checkSatelliteApiCompat(...)` from
  `@adonisjs-lasagna/saas-tenancy/sdk`. A satellite declares the ABI it was built
  against via `package.json#lasagnaSatellite.satelliteApi`. `configure` refuses to
  wire a satellite that needs a newer ABI than the installed core provides (and
  exits non-zero), warns on an older or undeclared one. The official satellites
  declare `satelliteApi: 1`.
- **Safer `configure` default.** A bare, non-interactive `node ace configure
  @adonisjs-lasagna/saas-tenancy` no longer auto-publishes every experimental core
  satellite's migrations. It publishes only the core config + tenant model;
  opt into satellites explicitly with `--with=`. The interactive prompt now
  preselects nothing. (Behaviour change to the scaffolding command only.)
- **Namespaced satellite migrations (data-loss fix).** Publishing a satellite's
  migrations now namespaces each file by package (`<ts>_<pkg_slug>__<stub>.ts`).
  Previously two satellites that shipped a stub with the same basename collided:
  the second was silently skipped and its table was never created. Namespacing is
  intrinsic, not opt-in — `publishSatellite(codemods, satellite, hostMigrationsDir)`
  now takes the host migrations directory as a required argument and reads the
  already-published set from it, so neither core's `--with=` path nor a
  satellite's own `configure` hook can forget to namespace. Idempotency
  recognizes both the namespaced form and the legacy un-namespaced one, so
  existing installs are not re-published as duplicates. (`migrationSlug` is
  exported from `/sdk`. The legacy un-namespaced form carries no package info, so
  during the pre-namespacing upgrade window a bare file is matched best-effort —
  keep your migration's TABLE name package-scoped, the documented convention.)
- **Inter-satellite dependencies.** A satellite can declare `dependsOn` other
  satellite packages in its manifest (`["@me/lib"]` or
  `[{ pkg, range }]`). `configure` pulls each dependency into the selection,
  orders dependencies before their dependents (so providers boot in order), and
  refuses the batch on a missing dependency or a cycle. The optional semver
  `range` is checked best-effort (a small dependency-free subset) and reported as
  a warning. Exposed as `resolveSatelliteDependencies` / `satisfiesRange` from
  `/sdk`.
- **Manifest path validation.** The `provider` and `commands` manifest fields are
  now validated as safe relative specifiers (no absolute path, no `..` segment),
  matching `migrations` — they are written into `adonisrc.ts` and imported on
  every boot.
- **Satellite removal guidance.** New `node ace tenant:satellite:remove <package>`
  prints a precise, safe checklist for removing a packaged satellite — the
  `adonisrc.ts` lines, the migrations it published, its config block, and the
  uninstall command. It never mutates the app or drops data: the AdonisJS
  codemods API has no provider/command removal, and migrations own real tenant
  data, so removal stays deliberate. (`configure` is idempotent, so a
  half-finished configure is recovered by re-running it.)
- **Stable homes for satellite helpers.** The pure tenant-id validators
  `isUuidV4` and `assertSafeIdentifier` are now exported from the bare-safe `/sdk`
  surface (the stable home for satellite authors), in addition to `/services`.
  The `/internal` subpath remains first-party-only and carries no stability
  guarantee.
- **Stripe types removed from the core surface (breaking).** The Stripe SDK type
  re-exports (`StripeEvent`, `StripeSubscription`, `StripeSubscriptionStatus`,
  `StripeCustomer`, `StripeInvoice`, `StripeCheckoutSession`, `StripePrice`,
  `StripeProduct`) and the `stripe` optional peer dependency are gone from
  `@adonisjs-lasagna/saas-tenancy`. Billing is a separate, multi-provider
  satellite, so the isolation core no longer couples its public surface to one
  payment provider. **Migration:** import these from `stripe` directly
  (`import type Stripe from 'stripe'`) or use billing's own event/payload types
  from `@adonisjs-lasagna/billing`.

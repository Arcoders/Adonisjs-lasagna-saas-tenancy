/**
 * Public surface for building packaged Lasagna satellites. See the
 * "Creating a satellite" cookbook for the full guide.
 *
 *  - `SatelliteManifest` / `readSatelliteManifest`: the declarative
 *    `package.json#lasagnaSatellite` contract.
 *  - `SatelliteProviderContract`: the provider lifecycle a satellite implements.
 *  - the configure toolkit (`discoverSatellites`, `publishSatellite`,
 *    `registerSatelliteInRcFile`, `printSatelliteManifest`, …) used by both
 *    core's `configure` and a satellite's own `adonisjs.configure` hook.
 */
export type { SatelliteManifest, SatelliteDependency, DiscoveredSatellite } from './manifest.js'
export { readSatelliteManifest, isSafeRelativePath } from './manifest.js'

export type { SatelliteProviderContract, SatelliteProviderConstructor } from './contract.js'

export {
  SATELLITE_API_VERSION,
  checkSatelliteApiCompat,
  assertSatelliteApiCompatAtBoot,
} from './api_version.js'
export type { SatelliteApiCompat } from './api_version.js'

/**
 * Per-surface extension contract versioning, one level below the Satellite
 * ABI. A satellite's extension registry calls `assertContractCompat` in its
 * `register()` to reject incompatible extensions at registration time. Pure +
 * bare-safe, so it works from a satellite's own unit runner.
 */
export {
  compareContractVersion,
  checkContractCompat,
  assertContractCompat,
} from './contract_version.js'
export type { ContractCompatLevel } from './contract_version.js'

export { resolveSatelliteDependencies, satisfiesRange } from './dependencies.js'
export type { DependencyResolution } from './dependencies.js'

/**
 * Tenant-id validators a satellite needs whenever it interpolates a tenant id
 * into SQL/DDL or reads one off a request/handshake. `isUuidV4` is a pure
 * predicate; `assertSafeIdentifier` refuses an unsafe id and audits the refusal
 * (it emits `guard.tenant_identifier` before it throws — the satellite's DDL
 * gets the same audit trail the kernel drivers do). Both are bare-safe (no
 * booted import), so they are usable from a satellite's own unit runner. This is
 * the stable home for satellite authors. (`assertSafeIdentifier` is also on
 * `/services` for in-app custom-driver authors.)
 */
export { isUuidV4 } from '../services/isolation/identifier.js'
export { assertSafeIdentifier } from '../isthmus/guarded_identifier.js'

/**
 * Build a SQL-safe `"schema"."table"` reference for a table in the shared backoffice
 * schema, honoring `config.backofficeSchemaName`. A satellite that writes raw SQL to
 * a backoffice table (a hash-chain ledger, an audit trail) uses this instead of a
 * hardcoded `backoffice.` prefix, so a host that renames the schema is honored. Pure
 * + bare-safe.
 */
export { qualifyBackofficeTable } from '../utils/backoffice_table.js'

/**
 * Bootstrap-time environment helpers a satellite provider needs before the app is
 * fully booted. `isProductionNodeEnv` matches the framework's prod/production
 * normalization (a security gate must not diverge from `app.inProduction`), and
 * `readBooleanEnvFlag` is the single normalized parse for a boolean toggle (so a
 * value typo/case never silently picks the safe branch). Both are bare-safe.
 */
export { isProductionNodeEnv, readBooleanEnvFlag } from '../utils/env.js'

/**
 * Resolve the Lucid `Database` from the container without repeating the
 * `'lucid.db' as never` cast at every satellite provider. A caller narrows the result
 * to the query surface it uses (a raw-SQL writer, a store).
 */
export { resolveLucidDb } from '../utils/lucid_db.js'

export type { CodemodsLike, LoggerLike } from './configure_kit.js'
export {
  filterAlreadyPublished,
  listExistingMigrations,
  discoverSatellites,
  indexSatellites,
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  migrationSlug,
} from './configure_kit.js'

/**
 * The shared Isthmus guard-audit. A satellite that ships fail-closed guards
 * builds ONE `createGuardAudit(...)` from its own registry, inheriting the
 * kernel's limiter/dispatcher/counter discipline and the shared `ISTHMUS_BUDGETS`
 * (so the whole fleet stays tuned together on a kernel retune). This is the
 * stable home for the machinery. A satellite never needs the unstable
 * `/internal` re-exports for it. Bare-safe (the default dispatcher resolves the
 * public event lazily). The public event stays `IsthmusGuardTripped` on
 * `/events`; the vocabulary types stay on `/types`.
 */
export { createGuardAudit, ISTHMUS_BUDGETS } from './guard_audit.js'
export type {
  GuardAuditEntry,
  GuardAuditInstance,
  GuardCountersSnapshot,
  GuardDispatcher,
  GuardEmitOptions,
  GuardMetricSink,
  CreateGuardAuditOptions,
} from './guard_audit.js'

/**
 * The Isthmus vocabulary types the guard-audit surface refers to (a satellite's
 * registry entries are typed against them, and the shared event payload flows
 * through the dispatcher). Re-exported so `/sdk` is self-contained for a
 * satellite author; they also live on the public `/types` barrel.
 */
export type {
  IsthmusPillar,
  IsthmusSeverity,
  IsthmusDropReason,
  IsthmusGuardTrippedPayload,
} from '../types/isthmus.js'

/**
 * Exhaustiveness helper for closed discriminated unions. A satellite calls it in
 * the `default:` arm of a `switch` so a new, unhandled variant is a COMPILE error
 * (the argument stops being assignable to `never`); at runtime it throws. This is
 * the one shared copy. Satellites no longer ship their own.
 */
export { assertNever } from './assert_never.js'

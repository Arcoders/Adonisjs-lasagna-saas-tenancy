import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'
import {
  filterAlreadyPublished,
  listExistingMigrations,
  discoverSatellites,
  indexSatellites,
  publishSatellite,
  registerSatelliteInRcFile,
  printSatelliteManifest,
  describePluginPermissions,
} from './src/sdk/configure_kit.js'
import { SATELLITE_API_VERSION, checkSatelliteApiCompat } from './src/sdk/api_version.js'
import { resolveSatelliteDependencies } from './src/sdk/dependencies.js'
import type { DiscoveredSatellite } from './src/sdk/manifest.js'

const stubsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'stubs')

/**
 * The files every install needs, whatever features it opts into. Each is written
 * only when absent, so `configure` stays re-run safe: a host that has edited its
 * repository keeps its edits.
 *
 * `path` is relative to the app root and must agree with the `exports({ to: … })`
 * line inside the matching stub — `behavior_configure_publish.spec.ts` pins that.
 */
export const CORE_SCAFFOLD: { path: string; stub: string }[] = [
  { path: 'app/models/backoffice/tenant.ts', stub: 'models/tenant.stub' },
  { path: 'app/repositories/tenant_repository.ts', stub: 'repositories/tenant_repository.stub' },
  { path: 'providers/tenancy_provider.ts', stub: 'providers/tenancy_provider.stub' },
]

/**
 * Each entry maps a core satellite feature name to the migration stubs that
 * implement it. The key is what the user passes via `--with=<feature>` (CSV)
 * or selects from the interactive prompt.
 *
 * Only the *leaf* satellites whose tables core still owns live here. Billing and
 * SSO moved their migrations into their own packages (`@adonisjs-lasagna/billing`,
 * `/sso`); they are now discovered as external satellites (see
 * `discoverSatellites`) and published through the shared satellite toolkit.
 */
export const SATELLITE_BUNDLES: Record<string, string[]> = {
  audit: ['create_tenant_audit_logs_table'],
  feature_flags: ['create_tenant_feature_flags_table'],
  webhooks: ['create_tenant_webhooks_table', 'create_tenant_webhook_deliveries_table'],
  branding: ['create_tenant_brandings_table'],
  // The metrics pipeline writes three backoffice tables: the daily counters
  // (tenant_metrics), the host-defined named metrics that `MetricsService.emitMetric`
  // flushes (tenant_custom_metrics), and the monthly rollup `tenant:metrics:rollup`
  // collapses into (tenant_metrics_monthly). All three ship together so a host that
  // selects metrics can emit custom metrics and run the rollup without a missing table.
  metrics: [
    'create_tenant_metrics_table',
    'create_tenant_custom_metrics_table',
    'create_tenant_metrics_monthly_table',
  ],
  // tenant_plans backs QuotaService.assignPlan/track. The billing satellite
  // (now an external package) declares `requires: ["quotas"]` so this table is
  // published before its own tables; `resolveMigrationStubs` dedups if both the
  // quotas feature and a billing `requires` ask for it.
  quotas: ['create_tenant_plans_table'],
}

/**
 * Opt-in hardening bundles. Unlike satellites these are NEVER published by
 * default: the RLS migration must be edited to list your real `rowScopeTables`
 * and only makes sense under the `rowscope-pg` driver, so publishing it
 * unprompted would emit a migration that fails on `migration:run`. Request it
 * explicitly with `--with=rls`.
 */
export const OPT_IN_BUNDLES: Record<string, string[]> = {
  'rls': ['enable_rls_tenant_isolation'],
  // Defense-in-depth RLS for the SHARED backoffice schema (satellite tables).
  // Opt-in for the same reason as `rls`: the migration must be edited to your
  // installed tables and only makes sense once the backoffice GUC is wired on
  // both the per-tenant and the cross-tenant-sweep paths. Request with
  // `--with=rls-backoffice`.
  'rls-backoffice': ['enable_rls_backoffice_isolation'],
  // Per-tenant maintenance mode adds an `is_maintenance` column to the host's
  // central `tenants` table. It alters host-owned schema rather than creating a
  // backoffice satellite table, so it is opt-in (never auto-published) and
  // requested explicitly with `--with=maintenance`.
  'maintenance': ['add_maintenance_to_tenants_table'],
}

export const ALL_FEATURES = Object.keys(SATELLITE_BUNDLES)
export const KNOWN_FEATURES = [...ALL_FEATURES, ...Object.keys(OPT_IN_BUNDLES)]

/**
 * Legacy short names for the official satellites whose migrations moved out of
 * core into their own package. Used ONLY to print a helpful "install it first"
 * message when the user passes `--with=billing` (or `sso`) but the package is
 * not installed (so discovery found nothing). When the package IS installed,
 * its manifest `aliases` resolve the short name through discovery instead.
 */
const OFFICIAL_SATELLITE_ALIASES: Record<string, string> = {
  billing: '@adonisjs-lasagna/billing',
  sso: '@adonisjs-lasagna/sso',
}

export function parseWithFlag(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null
  if (Array.isArray(raw)) {
    return raw
      .flatMap((v) => String(v).split(','))
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  }
  return null
}

/**
 * Split a requested feature list into the ones we know how to publish as core
 * bundles and the ones we don't. The caller routes `unknown` through external
 * satellite discovery / legacy-alias handling, then warns on anything left.
 */
export function filterUnknown(features: string[]): { known: string[]; unknown: string[] } {
  const known: string[] = []
  const unknown: string[] = []
  for (const f of features) {
    if (KNOWN_FEATURES.includes(f)) known.push(f)
    else unknown.push(f)
  }
  return { known, unknown }
}

/**
 * Flatten the selected core features into the ordered list of migration stub
 * names to publish. Order follows the selection, then each feature's bundle
 * order. Unknown features (no bundle) are skipped. Deduped by first appearance.
 */
export function resolveMigrationStubs(selected: string[]): string[] {
  const stubs: string[] = []
  const seen = new Set<string>()
  for (const feature of selected) {
    const bundle = SATELLITE_BUNDLES[feature] ?? OPT_IN_BUNDLES[feature]
    if (!bundle) continue
    for (const stub of bundle) {
      if (seen.has(stub)) continue
      seen.add(stub)
      stubs.push(stub)
    }
  }
  return stubs
}

/** The outcome of gating a satellite selection on the Satellite ABI version. */
export interface ApiCompatPartition {
  /** Satellites cleared to wire, in the same (dependency-first) order received. */
  accepted: DiscoveredSatellite[]
  /** Satellites refused, each with the operator-facing reason to log as an error. */
  refused: { packageName: string; reason: string }[]
  /** Advisory messages for accepted satellites built against an older/undeclared ABI. */
  warnings: string[]
}

/**
 * Partition a dependency-ordered satellite list by Satellite ABI compatibility,
 * BEFORE any of their code is wired into the host. A satellite that needs a
 * NEWER ABI than this core provides is refused; a satellite that depends on a
 * refused one is refused too (the input is dependency-first, so the dependency
 * has always been seen by the time its dependent is processed — this also
 * catches transitive chains). An OLDER or undeclared ABI is accepted with a
 * warning.
 *
 * Pure: no logger, no command, no fs. `configure()` applies the side effects
 * (logging each reason as an error, the warnings as warnings, and flipping the
 * exit code), and tests assert the decision directly. See
 * {@link checkSatelliteApiCompat} for the per-satellite comparison.
 */
export function partitionSatellitesByApiCompat(
  ordered: DiscoveredSatellite[],
  satIndex: Map<string, DiscoveredSatellite>,
  coreApiVersion: number = SATELLITE_API_VERSION
): ApiCompatPartition {
  const accepted: DiscoveredSatellite[] = []
  const refused: { packageName: string; reason: string }[] = []
  const refusedNames = new Set<string>()
  const warnings: string[] = []

  for (const sat of ordered) {
    const compat = checkSatelliteApiCompat(sat.manifest, sat.packageName, coreApiVersion)
    if (compat.level === 'fail') {
      refused.push({ packageName: sat.packageName, reason: compat.message })
      refusedNames.add(sat.packageName)
      continue
    }
    // A dependency was refused above. Resolve the declared name via the index,
    // since `dependsOn` may use an alias rather than the full package name.
    const brokenDep = (sat.manifest.dependsOn ?? [])
      .map((d) => satIndex.get(d.pkg)?.packageName ?? d.pkg)
      .find((pkg) => refusedNames.has(pkg))
    if (brokenDep) {
      refused.push({
        packageName: sat.packageName,
        reason: `${sat.packageName} depends on "${brokenDep}", which was refused above — skipping it too`,
      })
      refusedNames.add(sat.packageName)
      continue
    }
    if (compat.level === 'warn') warnings.push(compat.message)
    accepted.push(sat)
  }

  return { accepted, refused, warnings }
}

/**
 * Fail-closed install consent (S1): a satellite that declares permissions is only
 * published if the operator grants them. `--accept-permissions` (or
 * `LASAGNA_ACCEPT_PERMISSIONS=1`) grants non-interactively for CI; otherwise, on a
 * TTY, the operator is shown the concrete capabilities and prompted. A
 * non-interactive run WITHOUT the flag is a refusal, so a piped install can never
 * silently accept a plugin's sensitive capabilities.
 */
async function permissionsGranted(
  command: Configure,
  satellite: DiscoveredSatellite,
  permissions: readonly string[],
  flags: Record<string, unknown>
): Promise<boolean> {
  if (flags['accept-permissions'] === true || process.env.LASAGNA_ACCEPT_PERMISSIONS === '1') {
    return true
  }
  if (!process.stdout.isTTY) return false
  command.logger.warning(`${satellite.manifest.name} requests these permissions:`)
  for (const line of describePluginPermissions(permissions)) command.logger.log(`  - ${line}`)
  return command.prompt.confirm(`Grant ${satellite.manifest.name} the permissions above?`, {
    default: false,
  })
}

/**
 * Fail-closed native-addon acknowledgement (S4b): a satellite that ships native
 * (`.node`) addons cannot be sandboxed by the worker Permission Model — a native
 * addon evades `--permission` entirely — so it must be installed as fully-trusted
 * with an explicit `--allow-native` (or `LASAGNA_ALLOW_NATIVE_ADDONS=1`), or on a
 * TTY an explicit confirmation. A non-interactive install without the flag
 * refuses, so a scripted install can't silently pull in an un-sandboxable plugin.
 */
async function nativeAddonsAcknowledged(
  command: Configure,
  satellite: DiscoveredSatellite,
  flags: Record<string, unknown>
): Promise<boolean> {
  if (flags['allow-native'] === true || process.env.LASAGNA_ALLOW_NATIVE_ADDONS === '1') {
    return true
  }
  if (!process.stdout.isTTY) return false
  command.logger.warning(
    `${satellite.manifest.name} ships native addons, so it CANNOT be sandboxed by the ` +
      `worker Permission Model — it runs fully trusted. Its containment then rests on the ` +
      `read-only DB role and the container network policy.`
  )
  return command.prompt.confirm(`Install ${satellite.manifest.name} as fully trusted?`, {
    default: false,
  })
}

export default async function configure(command: Configure) {
  const flags = (command as any).parsed?.flags ?? {}
  const hostRoot: string = command.app.makePath()
  const warn = (m: string) => command.logger.warning(m)

  // `--list-satellites`: discover + print, publish nothing.
  if (flags['list-satellites']) {
    const satellites = await discoverSatellites(hostRoot, warn)
    printSatelliteList(command, satellites)
    return
  }

  const codemods = await command.createCodemods()

  // Register the core provider and commands in adonisrc.ts. `tenancy_provider`
  // (published below) binds TENANT_REPOSITORY and is registered first, so the
  // symbol is bound before the core provider boots.
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('#providers/tenancy_provider')
    rcFile.addProvider('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider')
    rcFile.addCommand('@adonisjs-lasagna/saas-tenancy/commands')
  })

  // Publish config file
  await codemods.makeUsingStub(stubsRoot, 'config/multitenancy.stub', {})

  // The three files a working install needs, each published only if absent so a
  // re-run never clobbers the host's edits: the tenant model, the repository the
  // package resolves through TENANT_REPOSITORY, and the provider that binds it.
  for (const scaffold of CORE_SCAFFOLD) {
    const target = command.app.makePath(scaffold.path)
    if (await fileExists(target)) {
      command.logger.info(`skipping ${scaffold.path} — already exists`)
      continue
    }
    await codemods.makeUsingStub(stubsRoot, scaffold.stub, {})
  }

  // The `tenants` table is not a feature — it is the table every command and
  // `request.tenant()` pivot on, so its migration is published unconditionally,
  // before the "no features selected" early return below.
  const migrationsDir = resolveMigrationsDir(command)
  const { toPublish: tenantsTable } = filterAlreadyPublished(
    ['create_tenants_table'],
    await listExistingMigrations(migrationsDir)
  )
  if (tenantsTable.length > 0) {
    await codemods.makeUsingStub(stubsRoot, 'migrations/create_tenants_table.stub', {})
    command.logger.info('published core migration: create_tenants_table')
  } else {
    command.logger.info('skipped already-published migration: create_tenants_table')
  }

  // Discover installed external satellites once (reads package.json only — never
  // imports a satellite).
  const satellites = await discoverSatellites(hostRoot, warn)
  const satIndex = indexSatellites(satellites)

  // Decide what to publish.
  //   1. Explicit --with=audit,@scope/pkg wins (core features + external satellites).
  //   2. Else if interactive (TTY): prompt the operator (core + installed externals),
  //      with NOTHING preselected — every satellite is experimental, so publishing
  //      one is an explicit opt-in, not a default.
  //   3. Else (CI / piped): publish NOTHING beyond the core config + tenant model
  //      (already emitted above). The core satellites are experimental and their
  //      migrations create backoffice tables; a bare run must not scaffold features
  //      the operator never asked for. Opt in with `--with=`; `--list-satellites`
  //      surfaces what is installed. External satellites are likewise opt-in.
  let selectedCore: string[] = []
  const selectedExternal: DiscoveredSatellite[] = []
  const externalSeen = new Set<string>()

  const flagValue = flags.with
  const fromFlag = parseWithFlag(flagValue)

  if (fromFlag) {
    const { known, unknown } = filterUnknown(fromFlag)
    selectedCore = known
    const stillUnknown: string[] = []
    for (const token of unknown) {
      const sat = satIndex.get(token)
      if (sat) {
        if (!externalSeen.has(sat.packageName)) {
          selectedExternal.push(sat)
          externalSeen.add(sat.packageName)
        }
      } else if (OFFICIAL_SATELLITE_ALIASES[token]) {
        const pkg = OFFICIAL_SATELLITE_ALIASES[token]
        command.logger.warning(
          `"${token}" now ships as ${pkg}. Install it (npm install ${pkg}) and re-run ` +
            `configure --with=${token}.`
        )
      } else {
        stillUnknown.push(token)
      }
    }
    if (stillUnknown.length > 0) {
      const installed = satellites.map((s) => s.packageName)
      command.logger.warning(
        `unknown feature(s): ${stillUnknown.join(', ')}. Known core: ${KNOWN_FEATURES.join(', ')}.` +
          (installed.length ? ` Installed satellites: ${installed.join(', ')}.` : '')
      )
    }
  } else if (process.stdout.isTTY && (command as any).prompt?.multiple) {
    const externalChoices = satellites.map((s) => s.packageName)
    const picked = (await (command as any).prompt.multiple(
      'Select features to publish (space to toggle, enter to confirm)',
      [...ALL_FEATURES, ...externalChoices],
      { default: [] }
    )) as string[]
    for (const p of picked) {
      if (ALL_FEATURES.includes(p)) {
        selectedCore.push(p)
      } else {
        const sat = satIndex.get(p)
        if (sat && !externalSeen.has(sat.packageName)) {
          selectedExternal.push(sat)
          externalSeen.add(sat.packageName)
        }
      }
    }
  } else {
    // Bare, non-interactive run: publish only the core config + tenant model
    // (already emitted above). Experimental satellites are opt-in via `--with=`.
    selectedCore = []
  }

  // Tracks whether we refused some/all of the requested external satellites, so
  // the "nothing to publish" branch below doesn't report a clean no-op when we
  // actually rejected the operator's selection.
  let externalBatchFailed = false

  // Resolve inter-satellite dependencies (`dependsOn`): pull each dependency
  // into the selection, order dependencies before dependents, and refuse the
  // batch on a missing dependency or a cycle. Range mismatches are advisory.
  if (selectedExternal.length > 0) {
    const dep = resolveSatelliteDependencies(selectedExternal, satIndex)
    for (const rm of dep.rangeMismatches) {
      command.logger.warning(
        `${rm.from} wants ${rm.pkg}@"${rm.range}" but ${rm.actual} is installed`
      )
    }
    if (dep.missing.length > 0 || dep.cycle) {
      for (const m of dep.missing) {
        command.logger.error(
          `${m.from} depends on "${m.pkg}", which is not installed — run \`npm install ${m.pkg}\``
        )
      }
      if (dep.cycle) {
        command.logger.error(`satellite dependency cycle: ${dep.cycle.join(' -> ')} -> …`)
      }
      command.logger.error(
        'refusing to configure external satellites until the dependency graph is valid'
      )
      ;(command as any).exitCode = 1
      externalBatchFailed = true
      selectedExternal.length = 0
    } else {
      // Replace with the topologically-ordered closure (deps first).
      selectedExternal.length = 0
      selectedExternal.push(...dep.ordered)
    }
  }

  // Gate external satellites on the Satellite ABI version BEFORE wiring any of
  // their code into the host. A satellite that needs a newer ABI than this core
  // provides is refused (and `configure` exits non-zero); an older / undeclared
  // one warns but proceeds. Pure check — see `checkSatelliteApiCompat`.
  //
  // `selectedExternal` is in dependency-first order here, so when we refuse a
  // satellite we also refuse anything that depends on it: wiring a dependent
  // whose dependency was rejected would boot it against a missing dependency.
  if (selectedExternal.length > 0) {
    const { accepted, refused, warnings } = partitionSatellitesByApiCompat(
      selectedExternal,
      satIndex,
      SATELLITE_API_VERSION
    )
    for (const message of warnings) command.logger.warning(message)
    if (refused.length > 0) {
      for (const r of refused) command.logger.error(r.reason)
      externalBatchFailed = true
      ;(command as any).exitCode = 1
    }
    selectedExternal.length = 0
    selectedExternal.push(...accepted)
  }

  // External satellites can require core bundles (e.g. billing needs `quotas`
  // for tenant_plans). Auto-add them so the shared table is published first.
  for (const sat of selectedExternal) {
    for (const req of sat.manifest.requires ?? []) {
      if (KNOWN_FEATURES.includes(req)) {
        if (!selectedCore.includes(req)) selectedCore.push(req)
      } else {
        command.logger.warning(
          `${sat.packageName} requires unknown core feature "${req}" — skipping that prerequisite`
        )
      }
    }
  }

  if (selectedCore.length === 0 && selectedExternal.length === 0) {
    if (externalBatchFailed) {
      command.logger.error('no external satellites were configured (see the errors above)')
    } else {
      command.logger.info(
        'no features selected — only the core config, scaffold and tenants migration published'
      )
    }
    return
  }

  // Publish the selected core migration stubs, skipping any already present.
  if (selectedCore.length > 0) {
    const resolved = resolveMigrationStubs(selectedCore)
    const existing = await listExistingMigrations(migrationsDir)
    const { toPublish, skipped } = filterAlreadyPublished(resolved, existing)

    for (const name of toPublish) {
      await codemods.makeUsingStub(stubsRoot, `migrations/${name}.stub`, {})
    }
    if (skipped.length > 0) {
      command.logger.info(
        `skipped already-published migrations (re-run safe): ${skipped.join(', ')}`
      )
    }
    command.logger.info(`published core migrations: ${selectedCore.join(', ')}`)
  }

  // Publish each external satellite's own migrations + register it in adonisrc.
  // `publishSatellite` reads the already-published set from `migrationsDir`
  // itself, so a satellite always sees the files an earlier one in this loop
  // just wrote (and namespaces its own).
  for (const sat of selectedExternal) {
    const permissions = sat.manifest.permissions
    if (permissions && permissions.length > 0) {
      if (!(await permissionsGranted(command, sat, permissions, flags))) {
        command.logger.warning(
          `skipping ${sat.packageName}: it requests permissions that were not granted. ` +
            `Re-run with --accept-permissions (or set LASAGNA_ACCEPT_PERMISSIONS=1 in CI) to accept.`
        )
        ;(command as any).exitCode = 1
        continue
      }
    }
    if (sat.manifest.nativeAddons && !(await nativeAddonsAcknowledged(command, sat, flags))) {
      command.logger.warning(
        `skipping ${sat.packageName}: it ships native addons and cannot be sandboxed. ` +
          `Re-run with --allow-native (or set LASAGNA_ALLOW_NATIVE_ADDONS=1 in CI) to install it as trusted.`
      )
      ;(command as any).exitCode = 1
      continue
    }
    const { published, skipped } = await publishSatellite(codemods, sat, migrationsDir)
    if (skipped.length > 0) {
      command.logger.info(
        `${sat.packageName}: skipped already-published migrations: ${skipped.join(', ')}`
      )
    }
    command.logger.info(
      `published satellite: ${sat.packageName} (${published.length} migration(s))`
    )
    await registerSatelliteInRcFile(codemods, sat.manifest)
    printSatelliteManifest(command.logger, sat.manifest)
  }

  // Stability notice for the core experimental satellites.
  const experimentalSelected = selectedCore.filter((f) => f in SATELLITE_BUNDLES)
  if (experimentalSelected.length > 0) {
    command.logger.warning(`experimental satellites: ${experimentalSelected.join(', ')}`)
    command.logger.log('  Experimental features are not part of the 1.x stability promise and may')
    command.logger.log(
      '  change in a minor release. Pin your version and check the changelog before'
    )
    command.logger.log('  upgrading. Stability matrix:')
    command.logger.log(
      '  https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/reference/stability'
    )
  }

  // Per-feature follow-ups for the core bundles.
  postPublishConfigReminders(command, selectedCore)

  if (selectedCore.includes('rls')) {
    postPublishRls(command)
  }
}

/** Print the `--list-satellites` table: core bundles + installed externals. */
function printSatelliteList(command: Configure, satellites: DiscoveredSatellite[]): void {
  const log = command.logger
  log.log('')
  log.log('Core satellite bundles (publish with --with=<name>):')
  for (const name of ALL_FEATURES) log.log(`  ${name}`)
  log.log('Opt-in hardening bundles:')
  for (const name of Object.keys(OPT_IN_BUNDLES)) log.log(`  ${name}`)

  log.log('')
  if (satellites.length === 0) {
    log.log('Installed external satellites: none found.')
    log.log('Publish one with: node ace configure @adonisjs-lasagna/saas-tenancy --with=<package>')
    return
  }
  log.log('Installed external satellites (publish with --with=<package> or its own configure):')
  for (const sat of satellites) {
    const reqs = sat.manifest.requires?.length
      ? ` requires: ${sat.manifest.requires.join(',')}`
      : ''
    log.log(`  ${sat.packageName}  (${sat.manifest.name})${reqs}`)
  }
}

/** Resolve the host's migrations directory (recursively scanned by the guard). */
function resolveMigrationsDir(command: Configure): string {
  const app = command.app as unknown as {
    migrationsPath?: (...p: string[]) => string
    makePath: (...p: string[]) => string
  }
  return typeof app.migrationsPath === 'function'
    ? app.migrationsPath()
    : app.makePath('database', 'migrations')
}

/**
 * Surface the config block each selected core feature needs. Most satellites
 * (audit, feature_flags, webhooks, branding) are zero-config and print nothing.
 * We never AST-patch the host's config — the operator pastes.
 */
function postPublishConfigReminders(command: Configure, selected: string[]): void {
  const log = command.logger
  const has = (f: string) => selected.includes(f)

  if (has('quotas')) {
    log.log('')
    log.log('— Quotas — additional setup —')
    log.log('Add to config/multitenancy.ts (inside defineConfig({...})):')
    log.log('  plans: {')
    log.log("    defaultPlan: 'free',")
    log.log('    definitions: {')
    log.log('      free: { limits: { apiCallsPerDay: 1000 } },')
    log.log('      pro:  { limits: { apiCallsPerDay: 100000 } },')
    log.log('    },')
    log.log("    storage: 'tenant_plans',")
    log.log('  },')
    log.log('Gate routes with the enforceQuota middleware from')
    log.log("  '@adonisjs-lasagna/saas-tenancy/middleware'.")
  }

  if (has('metrics')) {
    log.log('')
    log.log('— Metrics — additional setup —')
    log.log('Expose the Prometheus endpoint from start/routes.ts:')
    log.log('  multitenancyRoutes({ metricsMiddleware: middleware.auth() })')
    log.log('/metrics is fail-closed (it leaks tenant enumeration + KPIs): it refuses to')
    log.log('mount without a guard. Pass metricsMiddleware: false to mount it public on')
    log.log('purpose, behind a trusted network boundary.')
    log.log('Tune via billing.observability.metrics and resilience.redis.metrics (both optional).')
  }

  if (has('maintenance')) {
    log.log('')
    log.log('— Maintenance mode — additional setup —')
    log.log('The published migration ALTERS your central `tenants` table (adds is_maintenance).')
    log.log('Add an optional config/multitenancy.ts block to customise the response:')
    log.log('  maintenance: { retryAfterSeconds: 600, defaultMessage: "Back soon" },')
  }
}

/**
 * Post-publish hint for the RLS hardening migration. The stub ships with
 * placeholder table names on purpose — running it as-is would fail — so make
 * the required edit loud rather than letting `migration:run` blow up later.
 */
function postPublishRls(command: Configure): void {
  const log = command.logger
  log.log('')
  log.log('— Row-Level Security hardening — required edit —')
  log.log('A migration `*_enable_rls_tenant_isolation.ts` was published. Before running it:')
  log.log('  1. Edit TABLES to list your real rowScope tables (mirror isolation.rowScopeTables).')
  log.log('  2. Edit TENANT_COLUMN if you customised isolation.rowScopeColumn.')
  log.log('  3. Run your app under a DB role WITHOUT SUPERUSER/BYPASSRLS, then `migration:run`.')
  log.log(
    '  4. Wrap tenant work in withTenantRls(tenantId, (trx) => ...) so the policy sees the tenant.'
  )
  log.log('See docs/guides/data-isolation/rowscope-pg.md for the full pattern.')
}

async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

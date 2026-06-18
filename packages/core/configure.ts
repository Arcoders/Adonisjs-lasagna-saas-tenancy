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
} from './src/sdk/configure_kit.js'
import type { DiscoveredSatellite } from './src/sdk/manifest.js'

const stubsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'stubs')

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
  metrics: ['create_tenant_metrics_table'],
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
  rls: ['enable_rls_tenant_isolation'],
  // Per-tenant maintenance mode adds an `is_maintenance` column to the host's
  // central `tenants` table. It alters host-owned schema rather than creating a
  // backoffice satellite table, so it is opt-in (never auto-published) and
  // requested explicitly with `--with=maintenance`.
  maintenance: ['add_maintenance_to_tenants_table'],
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

  // Register the core provider and commands in adonisrc.ts
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider')
    rcFile.addCommand('@adonisjs-lasagna/saas-tenancy/commands')
  })

  // Publish config file
  await codemods.makeUsingStub(stubsRoot, 'config/multitenancy.stub', {})

  // Publish tenant model stub only if it doesn't already exist
  const modelPath = command.app.makePath('app/models/backoffice/tenant.ts')
  if (!(await fileExists(modelPath))) {
    await codemods.makeUsingStub(stubsRoot, 'models/tenant.stub', {})
  } else {
    command.logger.info('skipping app/models/backoffice/tenant.ts — already exists')
  }

  // Discover installed external satellites once (reads package.json only — never
  // imports a satellite).
  const satellites = await discoverSatellites(hostRoot, warn)
  const satIndex = indexSatellites(satellites)

  // Decide what to publish.
  //   1. Explicit --with=audit,@scope/pkg wins (core features + external satellites).
  //   2. Else if interactive (TTY): prompt the operator (core + installed externals).
  //   3. Else (CI / piped): publish ALL core satellites — the v1.x default. External
  //      satellites are opt-in (they need config + a provider), so they are NOT
  //      auto-published on a bare run; `--list-satellites` surfaces them.
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
      { default: ALL_FEATURES }
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
    selectedCore = [...ALL_FEATURES]
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
    command.logger.info('no features selected — only core config + tenant model published')
    return
  }

  const migrationsDir = resolveMigrationsDir(command)

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
  for (const sat of selectedExternal) {
    const existing = await listExistingMigrations(migrationsDir)
    const { published, skipped } = await publishSatellite(codemods, sat, existing)
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
    command.logger.log('  https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/stability')
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
  log.log('See docs/data-isolation/rowscope-pg.md for the full pattern.')
}

async function fileExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

import type Configure from '@adonisjs/core/commands/configure'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'

const stubsRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'stubs')

/**
 * Each entry maps a satellite feature name to the migration stubs that
 * implement it. The key is what the user passes via `--with=<feature>` (CSV)
 * or selects from the interactive prompt.
 */
export const SATELLITE_BUNDLES: Record<string, string[]> = {
  audit: ['create_tenant_audit_logs_table'],
  feature_flags: ['create_tenant_feature_flags_table'],
  webhooks: ['create_tenant_webhooks_table', 'create_tenant_webhook_deliveries_table'],
  branding: ['create_tenant_brandings_table'],
  sso: ['create_tenant_sso_configs_table'],
  metrics: ['create_tenant_metrics_table'],
  // tenant_plans backs QuotaService.assignPlan/track. It is shared with the
  // billing bundle below; `resolveMigrationStubs` dedups when both are
  // requested, so adopting quotas standalone (`--with=quotas`) and later
  // billing never emits the table twice.
  quotas: ['create_tenant_plans_table'],
  billing: [
    // tenant_plans backs QuotaService.assignPlan; required for billing wiring
    'create_tenant_plans_table',
    'create_stripe_customers_table',
    'create_stripe_subscriptions_table',
    'create_stripe_processed_events_table',
    'create_stripe_meter_events_table',
  ],
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
 * Split a requested feature list into the ones we know how to publish and the
 * ones we don't. The caller decides what to do with `unknown` (warn) and uses
 * `known` as the published set.
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
 * Flatten the selected features into the ordered list of migration stub names
 * to publish. Order follows the selection, then each feature's bundle order.
 * Unknown features (no bundle) are skipped. Deduped by first appearance:
 * `quotas` and `billing` share `create_tenant_plans_table`, so a request like
 * `--with=quotas,billing` must not emit that migration twice.
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

/**
 * Split resolved stub names into the ones not yet published and the ones
 * already present in the host's migrations directory. A stub counts as already
 * published when an existing file matches `<digits>_<stub>.ts` — migration
 * stubs are emitted as `${Date.now()}_<stub>.ts`, so the timestamp prefix is
 * always new and the codemod's own "file exists" skip never fires.
 *
 * This is what makes `configure` safe to re-run: a second pass with the same
 * (or overlapping) `--with`, or a bare re-run, skips the migrations it already
 * wrote instead of emitting timestamped duplicates that would later collide on
 * `migration:run`.
 */
export function filterAlreadyPublished(
  stubs: string[],
  existing: string[]
): { toPublish: string[]; skipped: string[] } {
  const toPublish: string[] = []
  const skipped: string[] = []
  for (const stub of stubs) {
    const escaped = stub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const re = new RegExp(`^\\d+_${escaped}\\.ts$`)
    if (existing.some((file) => re.test(file))) skipped.push(stub)
    else toPublish.push(stub)
  }
  return { toPublish, skipped }
}

export default async function configure(command: Configure) {
  const codemods = await command.createCodemods()

  // Register provider and commands in adonisrc.ts
  await codemods.updateRcFile((rcFile: any) => {
    rcFile.addProvider('@adonisjs-lasagna/saas-tenancy/providers/multitenancy_provider')
    rcFile.addCommand('@adonisjs-lasagna/saas-tenancy/commands')
  })

  // Publish config file
  await codemods.makeUsingStub(stubsRoot, 'config/multitenancy.stub', {})

  // Publish tenant model stub only if it doesn't already exist
  const modelPath = command.app.makePath('app/models/backoffice/tenant.ts')
  const modelExists = await access(modelPath)
    .then(() => true)
    .catch(() => false)

  if (!modelExists) {
    await codemods.makeUsingStub(stubsRoot, 'models/tenant.stub', {})
  } else {
    command.logger.info('skipping app/models/backoffice/tenant.ts — already exists')
  }

  // Decide which satellite features to publish.
  //   1. Explicit --with=audit,branding wins.
  //   2. Else if interactive (TTY): prompt the operator.
  //   3. Else (CI / piped): publish ALL satellites — the v1.x default. This
  //      keeps `node ace configure ...` non-breaking for existing scripts.
  const flagValue = (command as any).parsed?.flags?.with
  const fromFlag = parseWithFlag(flagValue)

  let selected: string[]
  if (fromFlag) {
    const { known, unknown } = filterUnknown(fromFlag)
    if (unknown.length > 0) {
      command.logger.warning(
        `unknown feature(s): ${unknown.join(', ')}. Known: ${KNOWN_FEATURES.join(', ')}`
      )
    }
    selected = known
  } else if (process.stdout.isTTY && (command as any).prompt?.multiple) {
    selected = (await (command as any).prompt.multiple(
      'Select satellite features to publish (space to toggle, enter to confirm)',
      ALL_FEATURES,
      { default: ALL_FEATURES }
    )) as string[]
  } else {
    selected = [...ALL_FEATURES]
  }

  if (selected.length === 0) {
    command.logger.info(
      'no satellite features selected — only core config + tenant model published'
    )
    return
  }

  // Publish migration stubs for every selected feature, skipping any already
  // present in the host's migrations directory. Migration stubs are emitted as
  // `${Date.now()}_<stub>.ts`, so without this guard a re-run would write
  // timestamped duplicates that collide on `migration:run`. The guard makes
  // `configure` idempotent: re-running it (even bare) is safe and additive.
  const resolved = resolveMigrationStubs(selected)
  const existing = await listExistingMigrations(command)
  const { toPublish, skipped } = filterAlreadyPublished(resolved, existing)

  for (const name of toPublish) {
    await codemods.makeUsingStub(stubsRoot, `migrations/${name}.stub`, {})
  }

  if (skipped.length > 0) {
    command.logger.info(
      `skipped already-published migrations (re-run safe): ${skipped.join(', ')}`
    )
  }
  command.logger.info(`published migrations: ${selected.join(', ')}`)

  // Stability notice. Every satellite is `experimental` in 1.x and is not
  // covered by the semver promise. Surface it once, at install, so reaching for
  // one is an informed choice rather than a surprise on the next minor. (`rls`
  // is core hardening, not a satellite, so it is excluded.)
  const experimentalSelected = selected.filter((f) => f in SATELLITE_BUNDLES)
  if (experimentalSelected.length > 0) {
    command.logger.warning(`experimental satellites: ${experimentalSelected.join(', ')}`)
    command.logger.log('  Experimental features are not part of the 1.x stability promise and may')
    command.logger.log(
      '  change in a minor release. Pin your version and check the changelog before'
    )
    command.logger.log('  upgrading. Stability matrix:')
    command.logger.log('  https://arcoders.github.io/Adonisjs-lasagna-saas-tenancy/docs/stability')
  }

  // Per-feature follow-ups. The config file is never overwritten on a re-run
  // (the codemod skips it), so any feature that needs a config block, a peer
  // package, or an env var must be surfaced here — pasting it is the host's job.
  postPublishConfigReminders(command, selected)

  if (selected.includes('rls')) {
    postPublishRls(command)
  }

  if (selected.includes('billing')) {
    // Publish the mailer + view so the QuotaExceededBillingListener has
    // something to dispatch out of the box. Both stubs are skipped if the
    // host already wrote their own (we never overwrite).
    const mailerPath = command.app.makePath('app/mailers/quota_warning_mailer.ts')
    if (!(await fileExists(mailerPath))) {
      await codemods.makeUsingStub(stubsRoot, 'mailers/quota_warning_mailer.stub', {})
    } else {
      command.logger.info('skipping app/mailers/quota_warning_mailer.ts — already exists')
    }

    const viewPath = command.app.makePath('resources/views/emails/quota_warning.edge')
    if (!(await fileExists(viewPath))) {
      await codemods.makeUsingStub(stubsRoot, 'views/emails/quota_warning.edge.stub', {})
    } else {
      command.logger.info('skipping resources/views/emails/quota_warning.edge — already exists')
    }

    await postPublishBilling(command)
  }
}

/**
 * Read the basenames of every file under the host's migrations directory
 * (recursively, so hosts that organise migrations into subfolders are still
 * covered). Best-effort: a host that hasn't created the directory yet is
 * treated as having no migrations. Feeds `filterAlreadyPublished`.
 */
async function listExistingMigrations(command: Configure): Promise<string[]> {
  const app = command.app as unknown as {
    migrationsPath?: (...p: string[]) => string
    makePath: (...p: string[]) => string
  }
  const dir =
    typeof app.migrationsPath === 'function'
      ? app.migrationsPath()
      : app.makePath('database', 'migrations')
  try {
    const { readdir } = await import('node:fs/promises')
    const entries = await readdir(dir, { recursive: true })
    return entries.map((entry) => entry.split(/[\\/]/).pop() ?? entry)
  } catch {
    return []
  }
}

/**
 * Surface the config block / peer package / env each selected feature needs.
 * Most satellites (audit, feature_flags, webhooks, branding) are zero-config
 * and intentionally print nothing. Billing has its own richer hint
 * (`postPublishBilling`); this covers the rest. We never AST-patch the host's
 * config — the file is not overwritten on a re-run, so the operator pastes.
 */
function postPublishConfigReminders(command: Configure, selected: string[]): void {
  const log = command.logger
  const has = (f: string) => selected.includes(f)

  if (has('sso')) {
    log.log('')
    log.log('— SSO satellite — additional setup —')
    log.log('Install the SSO package (ships the SsoService + TenantSsoConfig model):')
    log.log('  npm install @adonisjs-lasagna/sso')
    log.log('  npm install jose                      # optional, only for JWKS id-token verification')
    log.log("  import { SsoService, TenantSsoConfig } from '@adonisjs-lasagna/sso'")
  }

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
    log.log('Expose the Prometheus endpoint by calling multitenancyRoutes() from')
    log.log("  '@adonisjs-lasagna/saas-tenancy/health' in start/routes.ts (adds /metrics).")
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

/**
 * Post-publish hint for the billing satellite. We deliberately don't
 * AST-patch `start/routes.ts` or `config/multitenancy.ts` — host code
 * varies enough that an AST patch is brittle. Instead, surface the exact
 * snippets the operator needs to paste, with stable file references.
 *
 * Also nudges peer-dep installation if `stripe` isn't already a dependency.
 */
async function postPublishBilling(command: Configure): Promise<void> {
  const log = command.logger
  log.log('')
  log.log('— Billing satellite — additional setup —')

  try {
    const pkgPath = command.app.makePath('package.json')
    const pkgJson = JSON.parse(await (await import('node:fs/promises')).readFile(pkgPath, 'utf8'))
    const hasStripe = pkgJson?.dependencies?.stripe ?? pkgJson?.devDependencies?.stripe ?? null
    if (!hasStripe) {
      log.warning('stripe SDK not detected in package.json. Run:')
      log.log('    npm install stripe@^18')
    }
  } catch {
    /* fall through with the generic notice */
  }

  log.log('')
  log.log('Required environment variables:')
  log.log('  STRIPE_API_KEY=sk_test_...        (test key in dev, live key in prod)')
  log.log('  STRIPE_WEBHOOK_SECRET=whsec_...   (from the webhook endpoint in Stripe dashboard)')
  log.log('  STRIPE_API_VERSION=2025-08-27.basil   (optional; pin recommended)')

  log.log('')
  log.log('Install the billing satellite package (it ships its own provider + commands):')
  log.log('  npm install @adonisjs-lasagna/billing')

  log.log('')
  log.log('Register it in adonisrc.ts:')
  log.log("  providers: [() => import('@adonisjs-lasagna/billing/provider')]")
  log.log("  commands: [() => import('@adonisjs-lasagna/billing/commands')]")

  log.log('')
  log.log('Wire the webhook in start/routes.ts:')
  log.log("  import { multitenancyBillingRoutes } from '@adonisjs-lasagna/billing'")
  log.log('  multitenancyBillingRoutes()')

  log.log('')
  log.log('Add to config/multitenancy.ts (inside defineConfig({...})):')
  log.log("  ignorePaths: ['/admin', '/api/webhooks', '/health', '/webhooks/stripe'],")
  log.log('  billing: {')
  log.log("    driver: 'stripe',")
  log.log('    stripe: {')
  log.log("      apiKey: env.get('STRIPE_API_KEY'),")
  log.log("      webhookSecret: env.get('STRIPE_WEBHOOK_SECRET'),")
  log.log('    },')
  log.log(
    "    products: { prod_starter: 'starter', prod_pro: 'pro' },  // map your stripe product ids"
  )
  log.log("    defaultPlan: 'starter',")
  log.log('  },')
  log.log('')
  log.log('See docs/cookbook/stripe-quotas.md for the full reference.')
}

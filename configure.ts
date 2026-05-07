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
const SATELLITE_BUNDLES: Record<string, string[]> = {
  audit: ['create_tenant_audit_logs_table'],
  feature_flags: ['create_tenant_feature_flags_table'],
  webhooks: [
    'create_tenant_webhooks_table',
    'create_tenant_webhook_deliveries_table',
  ],
  branding: ['create_tenant_brandings_table'],
  sso: ['create_tenant_sso_configs_table'],
  metrics: ['create_tenant_metrics_table'],
}

const ALL_FEATURES = Object.keys(SATELLITE_BUNDLES)

function parseWithFlag(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null
  if (Array.isArray(raw)) {
    return raw.flatMap((v) => String(v).split(','))
      .map((s) => s.trim())
      .filter(Boolean)
  }
  if (typeof raw === 'string') {
    return raw.split(',').map((s) => s.trim()).filter(Boolean)
  }
  return null
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
    selected = fromFlag
    const unknown = selected.filter((f) => !ALL_FEATURES.includes(f))
    if (unknown.length > 0) {
      command.logger.warning(
        `unknown satellite feature(s): ${unknown.join(', ')}. Known: ${ALL_FEATURES.join(', ')}`
      )
      selected = selected.filter((f) => ALL_FEATURES.includes(f))
    }
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
    command.logger.info('no satellite features selected — only core config + tenant model published')
    return
  }

  // Publish migration stubs for every selected feature.
  for (const feature of selected) {
    const bundle = SATELLITE_BUNDLES[feature]
    if (!bundle) continue
    for (const name of bundle) {
      await codemods.makeUsingStub(stubsRoot, `migrations/${name}.stub`, {})
    }
  }

  command.logger.info(`published satellite migrations: ${selected.join(', ')}`)
}

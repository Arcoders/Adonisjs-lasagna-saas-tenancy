import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import type { Config } from '@japa/runner/types'

export const plugins: Config['plugins'] = [assert(), apiClient(), pluginAdonisJS(app)]

// Most specs provision inline (no worker), so enqueued InstallTenant jobs
// sit in Redis until queue_jobs/mail.spec start a worker — which then
// re-runs install() against already-active tenants, briefly flipping them
// through `provisioning` and surfacing as 503s in unrelated specs.
// Stubbing dispatch suite-wide kills that backlog; specs that need the
// real worker call useRealInstallTenantDispatch() in their group.setup.
let originalInstallTenantDispatch: any
let stubInstalled = false

async function installStubIfNeeded(): Promise<void> {
  if (stubInstalled) return
  const { InstallTenant } = await import('@adonisjs-lasagna/saas-tenancy/jobs')
  originalInstallTenantDispatch = InstallTenant.dispatch
  ;(InstallTenant as unknown as { dispatch: () => Promise<void> }).dispatch = async () => {}
  stubInstalled = true
}

// Restores the real InstallTenant.dispatch for groups that run their
// own queue:work. Pair with the returned thunk in teardown.
export async function useRealInstallTenantDispatch(): Promise<() => Promise<void>> {
  await installStubIfNeeded()
  const { InstallTenant } = await import('@adonisjs-lasagna/saas-tenancy/jobs')
  ;(InstallTenant as unknown as { dispatch: typeof originalInstallTenantDispatch }).dispatch =
    originalInstallTenantDispatch
  return async () => {
    ;(InstallTenant as unknown as { dispatch: () => Promise<void> }).dispatch = async () => {}
  }
}

export const configureSuite: Config['configureSuite'] = (suite) => {
  if (suite.name === 'e2e') {
    suite.setup(async () => {
      await testUtils.httpServer().start()
      await installStubIfNeeded()
      // The admin API and /metrics are gated by the backoffice realm, so the
      // suite seeds a real operator and mints its bearer once. Runs after the
      // external backoffice:setup step (CI and the e2e scripts), which is
      // what created backoffice_users.
      const { seedOperatorAndMintAdminToken } = await import('#tests/@integration/e2e/_helpers')
      await seedOperatorAndMintAdminToken()
      // pgvector (in its dedicated `extensions` schema) must exist BEFORE any tenant
      // is provisioned: config.ai.embedding folds the `ai_embeddings vector(N)`
      // migration into every tenant's `tenant:migrate`. Best-effort — on a plain
      // Postgres box without pgvector this throws and the AI e2e self-skip; in CI
      // (pgvector/pgvector:pg16) it installs the extension the tenant path resolves.
      try {
        const { provisionVectorExtension } = await import('@adonisjs-lasagna/saas-tenancy/services')
        await provisionVectorExtension()
      } catch {
        // pgvector unavailable locally; the AI e2e gate on it and self-skip.
      }
    })
  }
}

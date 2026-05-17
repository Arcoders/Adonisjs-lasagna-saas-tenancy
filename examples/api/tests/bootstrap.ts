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
    })
  }
}

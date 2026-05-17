import { assert } from '@japa/assert'
import { apiClient } from '@japa/api-client'
import { pluginAdonisJS } from '@japa/plugin-adonisjs'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import type { Config } from '@japa/runner/types'

export const plugins: Config['plugins'] = [assert(), apiClient(), pluginAdonisJS(app)]

/**
 * Suite-wide stub state for `InstallTenant.dispatch`. Without this stub,
 * every `POST /demo/tenants` in the suite enqueues a job to Redis — and
 * most specs use `installInline()` (in `_helpers.ts`) to provision the
 * tenant synchronously, never starting a worker. The job sits in the
 * queue.
 *
 * When a later spec arranges a `queue:work` subprocess (today:
 * `queue_jobs.spec.ts`, `mail.spec.ts`), that worker drains the backlog
 * and calls `tenant.install()` on tenants that are already `active` —
 * the job's own transitions go through `provisioning` for a few
 * milliseconds, during which any concurrent request hitting that
 * tenant gets a `TenantNotReadyException` → 503. The race surfaces as
 * intermittent 503s in specs that look unrelated (`satellites`,
 * `full`, `webhooks_delivery`…) because the failure mode depends on
 * which earlier spec last started a worker.
 *
 * Specs that legitimately need the worker to handle the job
 * (`queue_jobs`, `mail`) restore the real dispatch in their group
 * setup via `useRealInstallTenantDispatch()` below.
 */
let originalInstallTenantDispatch: any
let stubInstalled = false

async function installStubIfNeeded(): Promise<void> {
  if (stubInstalled) return
  const { InstallTenant } = await import('@adonisjs-lasagna/saas-tenancy/jobs')
  originalInstallTenantDispatch = InstallTenant.dispatch
  ;(InstallTenant as unknown as { dispatch: () => Promise<void> }).dispatch = async () => {}
  stubInstalled = true
}

/**
 * Specs that arrange a real `queue:work` subprocess and depend on it
 * processing `InstallTenant` jobs (queue_jobs.spec.ts, mail.spec.ts)
 * call this from their `group.setup` and pair it with the returned
 * `restore()` thunk from their teardown to re-apply the no-op stub.
 */
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

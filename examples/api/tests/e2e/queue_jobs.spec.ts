import { test } from '@japa/runner'
import { spawn, type ChildProcess } from 'node:child_process'
import db from '@adonisjs/lucid/services/db'
import Tenant from '#app/models/backoffice/tenant'
import { dropAllTenants, waitFor } from './_helpers.js'

/**
 * End-to-end coverage for the package's `@adonisjs/queue` jobs running through
 * a REAL `queue:work` worker subprocess — not `installInline()` (the helper the
 * rest of the suite uses to skip the queue) and not an inline `job.execute()`.
 *
 * This is the only place a real worker materialises a tenant: dispatch
 * `InstallTenant` (via `POST /demo/tenants`) → worker provisions the schema +
 * flips status to `active`; dispatch `UninstallTenant` (via `DELETE
 * /demo/tenants/:id`) → worker drops the schema. We assert the side effects in
 * Postgres, so a regression in the worker wiring (job-name resolution, payload
 * hydration, hook ordering, lock handling) fails here instead of silently in
 * production.
 *
 * Audit finding turned fix: `queue:work` couldn't resolve the package's jobs
 * because nothing registered them with `@adonisjs/queue`'s job Locator (host
 * apps auto-discover from `app/jobs/**`, which never reaches `node_modules`) —
 * dispatched jobs were dead-lettered. `MultitenancyProvider.boot()` now
 * registers them (`#registerQueueJobs`), which is exactly what makes this spec
 * pass.
 *
 * Needs Postgres + Redis (the CI `test-e2e-demo` job provides both).
 */
interface QueueWorker {
  child: ChildProcess
  output(): string
  stop(): Promise<void>
}

/**
 * Spawn `node ace queue:work` and resolve once it's plausibly ready: either
 * its output shows a "started" marker, or it's been alive for `settleMs`
 * without crashing. If it exits before that, reject with the captured output
 * so the failure is debuggable. (`LOG_LEVEL=error` in CI suppresses the
 * worker's info log, so we can't rely on the marker alone — hence the settle.)
 */
async function startQueueWorker(settleMs = 6000): Promise<QueueWorker> {
  const child = spawn('npx', ['tsx', 'ace.ts', 'queue:work'], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })

  const chunks: string[] = []
  const collect = (b: Buffer) => chunks.push(b.toString('utf8'))
  child.stdout?.on('data', collect)
  child.stderr?.on('data', collect)

  const worker: QueueWorker = {
    child,
    output: () => chunks.join(''),
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
          resolve()
        }, 3000)
        child.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
      })
    },
  }

  await new Promise<void>((resolve, reject) => {
    let done = false
    const finish = (fn: () => void) => {
      if (done) return
      done = true
      clearTimeout(timer)
      fn()
    }
    const onData = () => {
      if (/starting worker|processing|listening|ready/i.test(chunks.join(''))) {
        finish(resolve)
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('exit', (code) =>
      finish(() => reject(new Error(`queue:work exited (code ${code}) before becoming ready:\n${chunks.join('')}`)))
    )
    const timer = setTimeout(() => finish(resolve), settleMs)
  })

  return worker
}

async function schemaExists(schema: string): Promise<boolean> {
  const r = await db.rawQuery(
    `SELECT EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = ?) AS present`,
    [schema]
  )
  return Boolean(r.rows[0].present)
}

async function createTenantViaApi(client: any): Promise<string> {
  const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  const r = await client.post('/demo/tenants').json({
    name: `Q-${stamp}`,
    email: `${stamp}@queue.test`,
    plan: 'pro',
    tier: 'premium',
  })
  if (r.status() !== 202) {
    throw new Error(`POST /demo/tenants -> ${r.status()} ${JSON.stringify(r.body())}`)
  }
  return r.body().tenantId as string
}

test.group('e2e — BullMQ worker materialises and tears down tenants', (group) => {
  group.setup(() => dropAllTenants())
  group.teardown(() => dropAllTenants())

  test('queue:work processes InstallTenant: schema provisioned, status flips to active', async ({
    client,
    assert,
  }) => {
    const worker = await startQueueWorker()
    try {
      const id = await createTenantViaApi(client)
      const provisioned = await waitFor(
        async () => {
          const t = await Tenant.find(id)
          return t?.status === 'active' ? t : null
        },
        {
          timeoutMs: 40_000,
          intervalMs: 250,
          description: 'InstallTenant (via real queue:work) to flip status to active',
        }
      ).catch((err) => {
        // Surface the worker's stdout/stderr so a Locator/Redis failure is visible.
        throw new Error(`${(err as Error).message}\n--- queue:work output ---\n${worker.output()}`)
      })
      assert.equal(provisioned.status, 'active')
      assert.isTrue(
        await schemaExists(provisioned.schemaName),
        'tenant schema was created by the worker'
      )
    } finally {
      await worker.stop()
    }
  }).timeout(60_000)

  test('queue:work processes UninstallTenant: schema dropped after DELETE', async ({
    client,
    assert,
  }) => {
    const worker = await startQueueWorker()
    try {
      const id = await createTenantViaApi(client)
      const tenant = await waitFor(
        async () => {
          const t = await Tenant.find(id)
          return t?.status === 'active' ? t : null
        },
        { timeoutMs: 40_000, intervalMs: 250, description: 'install before uninstall' }
      ).catch((err) => {
        throw new Error(`${(err as Error).message}\n--- queue:work output ---\n${worker.output()}`)
      })
      const schema = tenant.schemaName
      assert.isTrue(await schemaExists(schema), 'precondition: schema exists')

      // Default DELETE (no ?keepSchema) queues UninstallTenant, which drops the schema.
      const del = await client.delete(`/demo/tenants/${id}`)
      assert.equal(del.status(), 202)

      await waitFor(async () => ((await schemaExists(schema)) ? null : true), {
        timeoutMs: 40_000,
        intervalMs: 250,
        description: 'UninstallTenant (via real queue:work) to drop the schema',
      }).catch((err) => {
        throw new Error(`${(err as Error).message}\n--- queue:work output ---\n${worker.output()}`)
      })
      assert.isFalse(await schemaExists(schema), 'worker dropped the tenant schema')
    } finally {
      await worker.stop()
    }
  }).timeout(60_000)
})
